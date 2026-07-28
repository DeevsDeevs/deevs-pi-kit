// Cron parsing and jitter behavior adapted from Kimi Code at
// f06eb5c60e0a4e51162d1854dda1db41892b457c (MIT).

export interface CronTask {
	id: string;
	cron: string;
	prompt: string;
	createdAt: number;
	recurring: boolean;
	lastFiredAt?: number;
}

export interface ParsedCron {
	raw: string;
	minutes: ReadonlySet<number>;
	hours: ReadonlySet<number>;
	daysOfMonth: ReadonlySet<number>;
	months: ReadonlySet<number>;
	daysOfWeek: ReadonlySet<number>;
	daysOfMonthWildcard: boolean;
	daysOfWeekWildcard: boolean;
}

const MINUTE = 60_000;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function parseCron(expression: string): ParsedCron {
	const raw = expression.trim().replace(/\s+/g, " ");
	const fields = raw.split(" ");
	if (!raw) throw new Error("Cron expression is empty.");
	if (fields.length !== 5) throw new Error(`Cron expression must have exactly 5 fields; got ${fields.length}.`);
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
	const daysOfWeek = new Set<number>();
	for (const value of parseField(dayOfWeek, 0, 7, "day-of-week")) daysOfWeek.add(value === 7 ? 0 : value);
	return {
		raw,
		minutes: parseField(minute, 0, 59, "minute"),
		hours: parseField(hour, 0, 23, "hour"),
		daysOfMonth: parseField(dayOfMonth, 1, 31, "day-of-month"),
		months: parseField(month, 1, 12, "month"),
		daysOfWeek,
		daysOfMonthWildcard: dayOfMonth === "*",
		daysOfWeekWildcard: dayOfWeek === "*",
	};
}

function parseField(field: string, min: number, max: number, name: string): Set<number> {
	const values = new Set<number>();
	for (const term of field.split(",")) {
		if (!term) throw new Error(`Cron ${name} field has an empty term.`);
		let range = term;
		let step = 1;
		const slash = term.indexOf("/");
		if (slash >= 0) {
			range = term.slice(0, slash);
			step = integer(term.slice(slash + 1), name, "step");
			if (step <= 0 || !range) throw new Error(`Cron ${name} step must be a positive integer after a range or *.`);
		}
		let low: number;
		let high: number;
		if (range === "*") {
			low = min;
			high = max;
		} else if (range.includes("-")) {
			const [from, to, ...extra] = range.split("-");
			if (extra.length || !from || !to) throw new Error(`Invalid cron ${name} range ${JSON.stringify(range)}.`);
			low = integer(from, name, "range lower bound");
			high = integer(to, name, "range upper bound");
		} else {
			low = integer(range, name, "value");
			if (slash < 0) {
				if (low < min || low > max) throw new Error(`Cron ${name} value ${low} is outside ${min}..${max}.`);
				values.add(low);
				continue;
			}
			high = max;
		}
		if (low < min || high > max || low > high) throw new Error(`Cron ${name} range ${low}-${high} is outside ${min}..${max}.`);
		for (let value = low; value <= high; value += step) values.add(value);
	}
	if (!values.size) throw new Error(`Cron ${name} field matches no values.`);
	return values;
}

function integer(raw: string, name: string, role: string): number {
	if (!/^\d+$/.test(raw)) throw new Error(`Cron ${name} ${role} must contain digits only.`);
	return Number.parseInt(raw, 10);
}

export function nextCronRun(cron: ParsedCron, fromMs: number): number | null {
	const date = new Date(fromMs);
	date.setSeconds(0, 0);
	date.setMinutes(date.getMinutes() + 1);
	const deadline = fromMs + 5 * 366 * 24 * 60 * MINUTE;
	while (date.getTime() <= deadline) {
		if (!cron.months.has(date.getMonth() + 1)) {
			date.setDate(1);
			date.setHours(0, 0, 0, 0);
			date.setMonth(date.getMonth() + 1);
			continue;
		}
		if (!dayMatches(cron, date)) {
			date.setHours(0, 0, 0, 0);
			date.setDate(date.getDate() + 1);
			continue;
		}
		if (!cron.hours.has(date.getHours())) {
			date.setMinutes(0, 0, 0);
			date.setHours(date.getHours() + 1);
			continue;
		}
		if (!cron.minutes.has(date.getMinutes())) {
			date.setSeconds(0, 0);
			date.setMinutes(date.getMinutes() + 1);
			continue;
		}
		return date.getTime();
	}
	return null;
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
	const dom = cron.daysOfMonth.has(date.getDate());
	const dow = cron.daysOfWeek.has(date.getDay());
	if (cron.daysOfMonthWildcard && cron.daysOfWeekWildcard) return true;
	if (cron.daysOfMonthWildcard) return dow;
	if (cron.daysOfWeekWildcard) return dom;
	return dom || dow;
}

export function cronToHuman(cron: ParsedCron): string {
	const allMinutes = fullRange(cron.minutes, 0, 59);
	const allHours = fullRange(cron.hours, 0, 23);
	const allMonths = fullRange(cron.months, 1, 12);
	if (allHours && cron.daysOfMonthWildcard && allMonths && cron.daysOfWeekWildcard) {
		const step = detectStep(cron.minutes, 0);
		if (step && step > 1) return `every ${step} minutes`;
		if (allMinutes) return "every minute";
		if (cron.minutes.size === 1) return `at minute ${[...cron.minutes][0]} of every hour`;
	}
	if (cron.minutes.size === 1 && cron.daysOfMonthWildcard && allMonths && cron.daysOfWeekWildcard) {
		const step = detectStep(cron.hours, 0);
		if (step && step > 1) return `every ${step} hours at minute ${pad([...cron.minutes][0]!)}`;
	}
	if (cron.minutes.size === 1 && cron.hours.size === 1 && cron.daysOfMonthWildcard && allMonths) {
		const time = `${pad([...cron.hours][0]!)}:${pad([...cron.minutes][0]!)}`;
		if (cron.daysOfWeekWildcard) return `at ${time} every day`;
		const days = [...cron.daysOfWeek].sort((a, b) => a - b);
		const label = days.length === 5 && days.every((value, index) => value === index + 1) ? "weekdays"
			: days.length === 2 && days[0] === 0 && days[1] === 6 ? "weekends"
			: days.map((value) => DAY_NAMES[value]).join(", ");
		return `at ${time} on ${label}`;
	}
	if (cron.minutes.size === 1 && cron.hours.size === 1 && cron.daysOfMonth.size === 1 && !cron.daysOfMonthWildcard && cron.months.size === 1 && cron.daysOfWeekWildcard) {
		return `at ${pad([...cron.hours][0]!)}:${pad([...cron.minutes][0]!)} on day ${[...cron.daysOfMonth][0]} of ${MONTH_NAMES[[...cron.months][0]! - 1]}`;
	}
	return cron.raw;
}

function fullRange(values: ReadonlySet<number>, min: number, max: number): boolean {
	if (values.size !== max - min + 1) return false;
	for (let value = min; value <= max; value++) if (!values.has(value)) return false;
	return true;
}

function detectStep(values: ReadonlySet<number>, min: number): number | null {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length < 2 || sorted[0] !== min) return null;
	const step = sorted[1]! - sorted[0]!;
	for (let index = 1; index < sorted.length; index++) if (sorted[index]! !== min + index * step) return null;
	return step;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function nextCronDelivery(task: CronTask, cron: ParsedCron, fromMs: number, noJitter = false): { ideal: number; delivery: number } | null {
	const ideal = nextCronRun(cron, fromMs);
	if (ideal === null) return null;
	if (noJitter) return { ideal, delivery: ideal };
	const fraction = Number.parseInt(task.id, 16) / 0x1_0000_0000;
	if (!task.recurring) {
		const minute = new Date(ideal).getMinutes();
		if (minute === 0 || minute === 30) {
			const shifted = ideal - 90_000 * fraction;
			if (shifted >= task.createdAt) return { ideal, delivery: shifted };
		}
		return { ideal, delivery: ideal };
	}
	const following = nextCronRun(cron, ideal);
	const period = following && following > ideal ? following - ideal : 24 * 60 * MINUTE;
	return { ideal, delivery: ideal + Math.min(period * 0.1, 15 * MINUTE) * fraction };
}

export function formatLocalTime(ms: number): string {
	const date = new Date(ms);
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absolute = Math.abs(offsetMinutes);
	const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

export function renderCronFire(input: { id: string; cron: string; recurring: boolean; coalescedCount: number; stale: boolean; prompt: string; deliveryId: string }): string {
	return [
		`<cron-fire id="${attribute(input.id)}" deliveryId="${attribute(input.deliveryId)}" cron="${attribute(input.cron)}" recurring="${input.recurring}" coalescedCount="${input.coalescedCount}" stale="${input.stale}">`,
		"<prompt>",
		input.prompt,
		"</prompt>",
		"</cron-fire>",
	].join("\n");
}

function attribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
