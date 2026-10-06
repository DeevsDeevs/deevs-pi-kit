// Cron parsing adapted from Kimi Code at
// f06eb5c60e0a4e51162d1854dda1db41892b457c (MIT).

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

export function parseCron(expression: string): ParsedCron {
	const raw = expression.trim().replace(/\s+/g, " ");
	const fields = raw.split(" ");
	if (!raw) throw new Error("Cron expression is empty.");
	if (fields.length !== 5) throw new Error(`Cron expression must have exactly 5 fields; got ${fields.length}.`);
	// SAFETY: exactly five fields was checked above.
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

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatLocalTime(ms: number): string {
	const date = new Date(ms);
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absolute = Math.abs(offsetMinutes);
	const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}
