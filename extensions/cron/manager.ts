import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cronToHuman, formatLocalTime, nextCronDelivery, nextCronRun, parseCron, renderCronFire, type CronTask, type ParsedCron } from "./cron.ts";

export const CRON_MESSAGE_TYPE = "deevs.cron-fire.v1";
const MAX_TASKS = 50;
const MAX_CRON_BYTES = 256;
const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_ONE_SHOT_FUTURE_MS = 350 * 24 * 60 * 60_000;
const STALE_MS = 7 * 24 * 60 * 60_000;
const CONFIRMATION_MS = 30_000;
const MAX_TIMER_MS = 2_147_000_000;
const MAX_COALESCE = 10_000;

interface PendingFire {
	deliveryId: string;
	taskId: string;
	cursor: number;
	coalescedCount: number;
	stale: boolean;
	lastAttemptAt?: number;
}

interface CronState {
	version: 1;
	sessionId: string;
	tasks: CronTask[];
	pending?: PendingFire;
}

export interface CronTaskView extends CronTask {
	humanSchedule: string;
	nextFireAt: number | null;
	stale: boolean;
}

export interface CronManagerOptions {
	root?: string;
	now?: () => number;
	automatic?: boolean;
	noJitter?: boolean;
}

export class CronManager {
	private ctx?: ExtensionContext;
	private state?: CronState;
	private statePath?: string;
	private timer?: NodeJS.Timeout;
	private confirmationTimer?: NodeJS.Timeout;
	private readonly parsed = new Map<string, ParsedCron>();

	constructor(private readonly pi: ExtensionAPI, private readonly options: CronManagerOptions = {}) {}

	restore(ctx: ExtensionContext): void {
		this.clearTimers();
		this.ctx = ctx;
		const sessionId = ctx.sessionManager.getSessionId();
		const persisted = ctx.sessionManager.getSessionFile() !== undefined;
		this.statePath = persisted ? path.join(this.options.root ?? defaultRoot(), `${safeSessionFileName(sessionId)}.json`) : undefined;
		this.state = this.load(sessionId);
		this.acknowledgeBranch(ctx);
		this.updateStatus();
		this.arm();
	}

	list(): CronTaskView[] {
		const now = this.now();
		return (this.state?.tasks ?? []).map((task) => {
			let humanSchedule = task.cron;
			let nextFireAt: number | null = null;
			try {
				const cron = this.getParsed(task.cron);
				humanSchedule = cronToHuman(cron);
				nextFireAt = nextCronDelivery(task, cron, baseline(task, now), this.noJitter())?.delivery ?? null;
			} catch {
				// Validated on create/load; retain a readable fallback if state changes underneath us.
			}
			return { ...task, humanSchedule, nextFireAt, stale: this.isStale(task, now) };
		});
	}

	create(input: { cron: string; prompt: string; recurring?: boolean }): CronTaskView {
		const state = this.requireState();
		if (state.tasks.length >= MAX_TASKS) throw new Error(`Cron task cap reached (${MAX_TASKS} per session).`);
		const prompt = input.prompt.trim();
		if (!prompt) throw new Error("Cron prompt must not be empty.");
		if (Buffer.byteLength(input.cron) > MAX_CRON_BYTES) throw new Error(`Cron expression exceeds ${MAX_CRON_BYTES} bytes.`);
		const promptBytes = Buffer.byteLength(prompt);
		if (promptBytes > MAX_PROMPT_BYTES) throw new Error(`Cron prompt exceeds ${MAX_PROMPT_BYTES} bytes (got ${promptBytes}).`);
		const cron = parseCron(input.cron);
		const now = this.now();
		const next = nextCronRun(cron, now);
		if (next === null) throw new Error(`Cron expression ${JSON.stringify(cron.raw)} has no fire within five years.`);
		const recurring = input.recurring !== false;
		if (!recurring && next - now > MAX_ONE_SHOT_FUTURE_MS) throw new Error(`One-shot cron would not fire until ${formatLocalTime(next)}; choose a future date within 350 days.`);
		let id: string;
		do id = randomBytes(4).toString("hex"); while (state.tasks.some((task) => task.id === id));
		const task: CronTask = { id, cron: cron.raw, prompt, createdAt: now, recurring };
		state.tasks.push(task);
		try { this.save(); } catch (error) {
			state.tasks.pop();
			throw error;
		}
		this.arm();
		return this.list().find((candidate) => candidate.id === id)!;
	}

	delete(id: string): CronTask {
		const state = this.requireState();
		if (!/^[0-9a-f]{8}$/.test(id)) throw new Error(`Invalid cron task id: ${id}`);
		const index = state.tasks.findIndex((task) => task.id === id);
		if (index < 0) throw new Error(`No cron task with id ${id}.`);
		if (state.pending?.taskId === id) throw new Error(`Cron task ${id} is already queued for delivery and cannot be withdrawn.`);
		const [removed] = state.tasks.splice(index, 1);
		try { this.save(); } catch (error) {
			state.tasks.splice(index, 0, removed!);
			throw error;
		}
		this.arm();
		return removed!;
	}

	tick(): void {
		if (!this.ctx || !this.state || this.disabled()) return;
		this.clearTimer();
		if (this.state.pending) {
			if (this.ctx.isIdle() && !this.ctx.hasPendingMessages()) this.sendPending();
			return;
		}
		if (!this.ctx.isIdle() || this.ctx.hasPendingMessages()) return;
		const now = this.now();
		for (const task of this.state.tasks) {
			let cron: ParsedCron;
			try {
				cron = this.getParsed(task.cron);
			} catch {
				continue;
			}
			const first = nextCronDelivery(task, cron, baseline(task, now), this.noJitter());
			if (!first || first.delivery > now) continue;
			let cursor = first.ideal;
			let coalescedCount = 1;
			if (task.recurring) {
				while (coalescedCount < MAX_COALESCE) {
					const next = nextCronDelivery(task, cron, cursor, this.noJitter());
					if (!next || next.delivery > now) break;
					cursor = next.ideal;
					coalescedCount++;
				}
			}
			this.state.pending = {
				deliveryId: `cron_${randomUUID()}`,
				taskId: task.id,
				cursor,
				coalescedCount,
				stale: this.isStale(task, now),
			};
			try { this.save(); } catch (error) {
				this.state.pending = undefined;
				this.updateStatus();
				this.ctx.ui.notify(`Cron could not persist a due fire: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			this.updateStatus();
			this.sendPending();
			return;
		}
		this.arm();
	}

	messageStarted(message: unknown): void {
		const value = message as { role?: string; customType?: string; details?: { deliveryId?: string } };
		if (value.role !== "custom" || value.customType !== CRON_MESSAGE_TYPE || !value.details?.deliveryId) return;
		this.acknowledgeDelivery(value.details.deliveryId);
	}

	dispose(): void {
		this.clearTimers();
		this.ctx?.ui.setStatus("cron", undefined);
		this.ctx = undefined;
		this.state = undefined;
		this.statePath = undefined;
		this.parsed.clear();
	}

	private sendPending(): void {
		const state = this.state;
		const ctx = this.ctx;
		const pending = state?.pending;
		if (!state || !ctx || !pending || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const task = state.tasks.find((candidate) => candidate.id === pending.taskId);
		if (!task) {
			state.pending = undefined;
			this.save();
			this.updateStatus();
			this.arm();
			return;
		}
		pending.lastAttemptAt = this.now();
		try { this.save(); } catch {
			// The pending reservation was already persisted before its first send.
		}
		try {
			this.pi.sendMessage({
				customType: CRON_MESSAGE_TYPE,
				content: renderCronFire({ ...task, deliveryId: pending.deliveryId, coalescedCount: pending.coalescedCount, stale: pending.stale }),
				display: true,
				details: { version: 1, deliveryId: pending.deliveryId, taskId: task.id, cron: task.cron, prompt: task.prompt, recurring: task.recurring, coalescedCount: pending.coalescedCount, stale: pending.stale },
			}, { triggerTurn: true, deliverAs: "followUp" });
		} catch {
			// The persisted pending delivery is retried below.
		}
		if (this.state?.pending?.deliveryId !== pending.deliveryId) return;
		this.clearConfirmationTimer();
		this.confirmationTimer = setTimeout(() => {
			this.confirmationTimer = undefined;
			if (this.state?.pending?.deliveryId === pending.deliveryId) this.tick();
		}, CONFIRMATION_MS);
		this.confirmationTimer.unref?.();
	}

	private arm(): void {
		this.clearTimer();
		if (this.options.automatic === false || !this.state || this.disabled()) return;
		if (this.state.pending) {
			const attempted = this.state.pending.lastAttemptAt ?? this.now();
			this.setTimer(Math.max(0, attempted + CONFIRMATION_MS - this.now()));
			return;
		}
		let next: number | null = null;
		for (const task of this.state.tasks) {
			try {
				const delivery = nextCronDelivery(task, this.getParsed(task.cron), baseline(task, this.now()), this.noJitter())?.delivery ?? null;
				if (delivery !== null && (next === null || delivery < next)) next = delivery;
			} catch {
				// A malformed persisted task must not block valid tasks.
			}
		}
		if (next !== null) this.setTimer(Math.max(0, next - this.now()));
	}

	private setTimer(delayMs: number): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.tick();
		}, Math.min(MAX_TIMER_MS, Math.max(1, delayMs)));
		this.timer.unref?.();
	}

	private updateStatus(): void {
		this.ctx?.ui.setStatus("cron", this.state?.pending ? "cron due" : undefined);
	}

	private acknowledgeBranch(ctx: ExtensionContext): void {
		const pendingId = this.state?.pending?.deliveryId;
		if (!pendingId) return;
		for (const entry of ctx.sessionManager.getBranch() as readonly unknown[]) {
			const value = entry as { type?: string; customType?: string; details?: { deliveryId?: string } };
			if (value.type === "custom_message" && value.customType === CRON_MESSAGE_TYPE && value.details?.deliveryId === pendingId) {
				this.acknowledgeDelivery(pendingId);
				return;
			}
		}
	}

	private acknowledgeDelivery(deliveryId: string): void {
		const state = this.state;
		if (!state?.pending || state.pending.deliveryId !== deliveryId) return;
		const pending = state.pending;
		const task = state.tasks.find((candidate) => candidate.id === pending.taskId);
		if (task) {
			if (!task.recurring || pending.stale) state.tasks = state.tasks.filter((candidate) => candidate.id !== task.id);
			else task.lastFiredAt = pending.cursor;
		}
		state.pending = undefined;
		this.clearConfirmationTimer();
		try { this.save(); } catch (error) {
			this.ctx?.ui.notify(`Cron admission is in session history but its state file could not be updated: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		this.updateStatus();
		this.arm();
	}

	private load(sessionId: string): CronState {
		if (!this.statePath || !existsSync(this.statePath)) return { version: 1, sessionId, tasks: [] };
		try {
			if (statSync(this.statePath).size > MAX_STATE_BYTES) throw new Error("cron state is too large");
			const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<CronState>;
			if (raw.version !== 1 || raw.sessionId !== sessionId || !Array.isArray(raw.tasks)) throw new Error("invalid cron state");
			const ids = new Set<string>();
			const tasks = raw.tasks.filter(validTask).filter((task) => {
				if (ids.has(task.id)) return false;
				try { parseCron(task.cron); } catch { return false; }
				ids.add(task.id);
				return true;
			}).slice(0, MAX_TASKS);
			const pending = raw.pending && validPending(raw.pending) && tasks.some((task) => task.id === raw.pending!.taskId) ? raw.pending : undefined;
			return { version: 1, sessionId, tasks, pending };
		} catch {
			return { version: 1, sessionId, tasks: [] };
		}
	}

	private save(): void {
		if (!this.statePath || !this.state) return;
		mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.statePath}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, this.statePath);
	}

	private requireState(): CronState {
		if (!this.state) throw new Error("Cron is unavailable before a Pi session starts.");
		return this.state;
	}

	private getParsed(expression: string): ParsedCron {
		const cached = this.parsed.get(expression);
		if (cached) return cached;
		const parsed = parseCron(expression);
		this.parsed.set(expression, parsed);
		return parsed;
	}

	private isStale(task: CronTask, now: number): boolean {
		return !this.noStale() && task.recurring && Number.isFinite(now - task.createdAt) && now - task.createdAt >= STALE_MS;
	}

	private noJitter(): boolean {
		return this.options.noJitter ?? process.env.DEEVS_PI_CRON_NO_JITTER === "1";
	}

	private noStale(): boolean {
		return process.env.DEEVS_PI_CRON_NO_STALE === "1";
	}

	private disabled(): boolean {
		return process.env.DEEVS_PI_DISABLE_CRON === "1";
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private clearConfirmationTimer(): void {
		if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
		this.confirmationTimer = undefined;
	}

	private clearTimers(): void {
		this.clearTimer();
		this.clearConfirmationTimer();
	}
}

function baseline(task: CronTask, now: number): number {
	return task.lastFiredAt !== undefined && Number.isFinite(task.lastFiredAt) && task.lastFiredAt <= now && task.lastFiredAt > task.createdAt ? task.lastFiredAt : task.createdAt;
}

function validTask(value: unknown): value is CronTask {
	const task = value as Partial<CronTask>;
	return typeof task?.id === "string" && /^[0-9a-f]{8}$/.test(task.id)
		&& typeof task.cron === "string" && task.cron.length > 0 && Buffer.byteLength(task.cron) <= MAX_CRON_BYTES
		&& typeof task.prompt === "string" && task.prompt.trim().length > 0 && Buffer.byteLength(task.prompt) <= MAX_PROMPT_BYTES
		&& typeof task.createdAt === "number" && Number.isFinite(task.createdAt)
		&& typeof task.recurring === "boolean"
		&& (task.lastFiredAt === undefined || typeof task.lastFiredAt === "number" && Number.isFinite(task.lastFiredAt));
}

function validPending(value: unknown): value is PendingFire {
	const pending = value as Partial<PendingFire>;
	return typeof pending?.deliveryId === "string" && pending.deliveryId.length <= 128
		&& typeof pending.taskId === "string"
		&& typeof pending.cursor === "number" && Number.isFinite(pending.cursor)
		&& typeof pending.coalescedCount === "number" && Number.isInteger(pending.coalescedCount) && pending.coalescedCount >= 1 && pending.coalescedCount <= MAX_COALESCE
		&& typeof pending.stale === "boolean"
		&& (pending.lastAttemptAt === undefined || typeof pending.lastAttemptAt === "number" && Number.isFinite(pending.lastAttemptAt));
}

function safeSessionFileName(sessionId: string): string {
	return /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) ? sessionId : createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function defaultRoot(): string {
	return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "cron");
}
