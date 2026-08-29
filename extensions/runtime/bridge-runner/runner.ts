import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { HostedRuntimeClient, HostedRuntimeClientError } from "../client.ts";
import { ownsProcessIdentity, quiesceProcessGroup, readProcessIdentity } from "../../shared/process-group.ts";
import { BridgeJournalStore, readWorkerState, writeRunnerConfig, writeWorkerSpec } from "./journal.ts";
import { bridgeProcessEnvironment } from "./adapters.ts";
import { BRIDGE_RUNNER_MAX_BODY_BYTES, BRIDGE_RUNNER_MAX_TURNS, type BridgeAdmission, type BridgeJournal, type BridgeRunnerConfig, type BridgeTurn, type BridgeWorkerSpec, type BridgeWorkerState } from "./types.ts";

const WORKER = fileURLToPath(new URL("./worker.ts", import.meta.url));
const HEARTBEAT_MS = 2_000;
const RETAINED_SETTLED_TURNS = 64;

interface RuntimeRegistration {
	targetKey: string;
	registrationId: string;
	registrationKey: string;
	participantKey: string;
	holderGeneration: string;
}

export interface BridgeRuntimeClient { call(method: string, params: unknown): Promise<unknown>; }
export interface BridgeRunnerOptions { herdrIdentity?: () => Promise<{ paneId: string; terminalId: string }>; workerPath?: string; readyTimeoutMs?: number; client?: BridgeRuntimeClient; afterWorkerAuthorized?: () => void | Promise<void>; }

interface ClaimEvent {
	eventId: string;
	type: "mailbox.message" | "mailbox.task";
	payload: { senderParticipantKey: string; body: string };
}

export class BridgeRunner {
	private readonly configPath: string;
	private config: BridgeRunnerConfig;
	private readonly client: BridgeRuntimeClient;
	private readonly journal: BridgeJournalStore;
	private readonly options: BridgeRunnerOptions;
	private registration?: RuntimeRegistration;
	private heartbeatAt = 0;
	private stopped = false;

	constructor(configPath: string, config: BridgeRunnerConfig, initial?: BridgeJournal, options: BridgeRunnerOptions = {}) {
		this.configPath = configPath;
		this.config = config;
		this.options = options;
		this.client = options.client ?? new HostedRuntimeClient(config.runtimeSocket, 5_000);
		this.journal = new BridgeJournalStore(config.root, initial ?? { version: 1, bridgeId: config.bridgeId, driver: config.driver, protocol: config.protocol, participantId: config.participantId, nextSequence: 1, admissions: [], turns: [], status: "starting", updatedAt: Date.now() });
		this.update((state) => state);
	}

	state(): BridgeJournal { return this.journal.read(); }

	async start(): Promise<void> {
		await this.register();
		await this.recover();
		this.update((state) => ({ ...state, status: state.status === "needs_attention" || state.turns.some((turn) => turn.state === "needs_attention") ? "needs_attention" : "running" }));
	}

	async step(): Promise<"idle" | "admitted" | "working" | "sent" | "needs_attention"> {
		if (this.stopped) return "idle";
		try {
			if (!this.registration) await this.register();
			else if (Date.now() - this.heartbeatAt >= HEARTBEAT_MS) {
				await this.client.call("bridge.heartbeat", auth(this.registration));
				this.heartbeatAt = Date.now();
			}
			const state = this.journal.read();
			if (state.status === "needs_attention") return "needs_attention";
			const turn = state.turns.find((candidate) => candidate.state !== "reply_sent");
			if (turn) return await this.advance(turn);
			return await this.claim();
		} catch (error) {
			if (error instanceof HostedRuntimeClientError && (error.code === "unavailable" || error.code === "registration_stale")) { this.registration = undefined; return "idle"; }
			throw error;
		}
	}

	async run(signal?: AbortSignal): Promise<void> {
		await this.start();
		while (!this.stopped && !signal?.aborted) {
			const result = await this.step();
			await delay(result === "idle" ? 250 : 25);
		}
		if (signal?.aborted) await this.cancelActive();
	}

	async cancelActive(): Promise<void> {
		const turn = this.journal.read().turns.find((candidate) => candidate.state === "starting" || candidate.state === "running");
		if (!turn?.worker) return;
		this.replaceTurn(turn.eventId, (current) => ({ ...current, worker: { ...current.worker!, cancelRequested: true }, updatedAt: Date.now() }));
		await this.settleCancellation(turn.eventId, turn.worker.statePath);
	}

	stop(): void { this.stopped = true; this.update((state) => ({ ...state, status: state.status === "needs_attention" ? state.status : "stopped" })); }

	private async register(): Promise<void> {
		const admittedClaims = this.journal.read().admissions.filter((item) => item.ack === "uncertain").slice(-12).map(({ claimId, eventIds }) => ({ claimId, eventIds }));
		const common = { clientGeneration: this.config.clientGeneration, admittedClaims, herdr: await (this.options.herdrIdentity?.() ?? currentHerdrIdentity()) };
		let result: unknown;
		if (this.config.launchToken) {
			try { result = await this.client.call("bridge.register", { ...common, launchToken: this.config.launchToken, reconnectToken: this.config.reconnectToken }); }
			catch (error) {
				if (!this.config.targetKey || !(error instanceof HostedRuntimeClientError) || error.code !== "unavailable") throw error;
				result = await this.client.call("bridge.reconnect", { ...common, targetKey: this.config.targetKey, reconnectToken: this.config.reconnectToken });
			}
		} else {
			if (!this.config.targetKey) throw new Error("Bridge runner has no launch or reconnect target authority.");
			result = await this.client.call("bridge.reconnect", { ...common, targetKey: this.config.targetKey, reconnectToken: this.config.reconnectToken });
		}
		const registration = parseRegistration(result, this.config);
		this.registration = registration;
		this.heartbeatAt = Date.now();
		this.config = { ...this.config, targetKey: registration.targetKey, launchToken: undefined };
		writeRunnerConfig(this.configPath, this.config);
		this.update((state) => ({ ...state, targetKey: registration.targetKey, participantKey: registration.participantKey, holderGeneration: registration.holderGeneration, admissions: state.admissions.map((item) => item.ack === "uncertain" ? { ...item, ack: "confirmed" } : item) }));
	}

	private async claim(): Promise<"idle" | "admitted"> {
		const registration = this.requireRegistration();
		let value: unknown;
		try { value = await this.client.call("inbox.claim", auth(registration)); }
		catch (error) { if (error instanceof HostedRuntimeClientError && error.code === "not_found") return "idle"; throw error; }
		const claim = parseClaim(value);
		const now = Date.now();
		this.update((state) => {
			if (state.turns.length + claim.events.length > BRIDGE_RUNNER_MAX_TURNS) throw new Error(`Bridge journal exceeds ${BRIDGE_RUNNER_MAX_TURNS} turns.`);
			const known = new Set(state.turns.map((turn) => turn.eventId));
			const turns = [...state.turns];
			let nextSequence = state.nextSequence;
			for (const event of claim.events) if (!known.has(event.eventId)) {
				turns.push({ turnId: `turn_${randomUUID()}`, sequence: nextSequence++, eventId: event.eventId, claimId: claim.claimId, senderParticipantKey: event.payload.senderParticipantKey, body: event.payload.body, ...(event.type === "mailbox.task" ? { task: true as const } : {}), state: "pending", attempt: 0, replySendId: replySendId(state.bridgeId, event.eventId), reply: "unsent", createdAt: now, updatedAt: now });
			}
			const admissions = state.admissions.some((item) => item.claimId === claim.claimId) ? state.admissions : [...state.admissions, { claimId: claim.claimId, eventIds: claim.eventIds, ack: "uncertain", createdAt: now } satisfies BridgeAdmission];
			return { ...state, admissions, turns, nextSequence };
		});
		try {
			await this.client.call("inbox.ack", { ...auth(registration), claimId: claim.claimId, eventIds: claim.eventIds });
			this.confirmAdmission(claim.claimId);
		} catch {
			this.registration = undefined;
			await this.register();
		}
		return "admitted";
	}

	private async advance(turn: BridgeTurn): Promise<"working" | "sent" | "needs_attention"> {
		if (turn.terminal && this.rejectUncertainNativeSession(turn.eventId, turn.terminal)) return "needs_attention";
		const admission = this.journal.read().admissions.find((item) => item.claimId === turn.claimId);
		if (!admission || admission.ack !== "confirmed") { await this.register(); return "working"; }
		if (turn.state === "pending") { await this.launchWorker(turn); return "working"; }
		if (turn.state === "starting" || turn.state === "running") return this.pollWorker(turn);
		if (turn.state === "terminal") { this.setReplyPending(turn.eventId, turn.terminal!); return "working"; }
		if (turn.state === "reply_pending") return this.publish(turn);
		this.needsAttention(turn.eventId);
		return "needs_attention";
	}

	private async launchWorker(turn: BridgeTurn): Promise<void> {
		const attempt = turn.attempt + 1;
		const turnRoot = join(this.config.root, "turns", turn.turnId, `attempt-${attempt}`);
		mkdirSync(turnRoot, { recursive: true, mode: 0o700 });
		const statePath = join(turnRoot, "worker.v1.json");
		const specPath = join(turnRoot, "spec.v1.json");
		const priorSessionId = this.journal.read().driverSessionId;
		const sessionId = priorSessionId ?? (this.config.driver === "claude-code" ? randomUUID() : undefined);
		const spec: BridgeWorkerSpec = { version: 1, turnId: turn.turnId, eventId: turn.eventId, attempt, driver: this.config.driver, cwd: this.config.cwd, body: turn.body, ...(this.config.profile ? { profile: this.config.profile } : {}), ...(this.config.model ? { model: this.config.model } : {}), ...(this.config.persona ? { persona: this.config.persona } : {}), ...(sessionId ? { sessionId } : {}), ...(priorSessionId ? { resumeSession: true } : {}), statePath, wallMs: this.config.wallMs };
		writeWorkerSpec(specPath, spec);
		this.replaceTurn(turn.eventId, (current) => ({ ...current, state: "starting", attempt, worker: { attempt, statePath }, updatedAt: Date.now() }));
		const child = fork(this.options.workerPath ?? WORKER, [specPath], { execArgv: ["--experimental-strip-types"], cwd: this.config.cwd, detached: true, env: bridgeProcessEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
		const readyOutcome = waitReady(child, this.options.readyTimeoutMs ?? 5_000).then((ready) => ({ ready }), (error: Error) => ({ error }));
		const workerPid = child.pid;
		const workerIdentity = workerPid ? await readProcessIdentity(workerPid) : undefined;
		if (!workerPid || !workerIdentity) { if (child.connected) child.disconnect(); this.needsAttention(turn.eventId); return; }
		this.replaceTurn(turn.eventId, (current) => ({ ...current, worker: { attempt, statePath, workerPid, workerIdentity }, updatedAt: Date.now() }));
		const outcome = await readyOutcome;
		if ("error" in outcome) {
			if (!await ownsProcessIdentity(workerPid, workerIdentity) || !await quiesceProcessGroup(workerPid)) this.needsAttention(turn.eventId);
			else this.replaceTurn(turn.eventId, (current) => ({ ...current, state: "pending", worker: undefined, updatedAt: Date.now() }));
			return;
		}
		const ready = outcome.ready;
		const worker = readWorkerState(statePath);
		if (!worker || worker.workerPid !== workerPid || worker.workerIdentity !== workerIdentity || worker.workerPid !== ready.workerPid || worker.workerIdentity !== ready.workerIdentity) {
			if (await ownsProcessIdentity(workerPid, workerIdentity)) await quiesceProcessGroup(workerPid);
			this.needsAttention(turn.eventId);
			return;
		}
		try { await authorizeWorkerStart(child); }
		catch {
			if (await ownsProcessIdentity(workerPid, workerIdentity)) await quiesceProcessGroup(workerPid);
			this.needsAttention(turn.eventId);
			return;
		}
		await this.options.afterWorkerAuthorized?.();
		this.replaceTurn(turn.eventId, (current) => ({ ...current, state: "running", worker: { attempt, statePath, workerPid, workerIdentity }, updatedAt: Date.now() }));
		child.unref();
	}

	private async pollWorker(turn: BridgeTurn): Promise<"working" | "needs_attention"> {
		const worker = turn.worker ? readWorkerState(turn.worker.statePath) : undefined;
		if (!worker) return "working";
		if (worker.status === "terminal" && worker.terminal) {
			this.importTerminal(turn.eventId, worker.terminal);
			return "working";
		}
		if (worker.status === "needs_attention" || !await ownsProcessIdentity(worker.workerPid, worker.workerIdentity)) {
			if (await this.hasProcessWitness(worker)) await quiesceProcessGroup(worker.workerPid);
			this.needsAttention(turn.eventId);
			return "needs_attention";
		}
		return "working";
	}

	private async publish(turn: BridgeTurn): Promise<"working" | "sent" | "needs_attention"> {
		const registration = this.requireRegistration();
		const body = (turn.replyBody ?? turn.terminal?.body ?? "Bridge turn failed without a result.").slice(0, BRIDGE_RUNNER_MAX_BODY_BYTES);
		if (turn.reply !== "uncertain" || turn.replyBody !== body) this.replaceTurn(turn.eventId, (current) => ({ ...current, replyBody: body, reply: "uncertain", updatedAt: Date.now() }));
		try {
			if (turn.task) await this.client.call("task.result", { ...auth(registration), senderParticipantKey: registration.participantKey, expectedSenderGeneration: registration.holderGeneration, eventId: turn.eventId, sendId: turn.replySendId, status: turn.terminal!.status, body, sessionAdvance: turn.terminal!.sessionAdvance });
			else await this.client.call("mailbox.send", { ...auth(registration), senderParticipantKey: registration.participantKey, expectedSenderGeneration: registration.holderGeneration, recipientParticipantKey: turn.senderParticipantKey, sendId: turn.replySendId, body });
			this.replaceTurn(turn.eventId, (current) => ({ ...current, state: "reply_sent", reply: "sent", replyBody: body, updatedAt: Date.now() }));
			return "sent";
		} catch (error) {
			if (error instanceof HostedRuntimeClientError && (error.code === "unavailable" || error.code === "registration_stale")) {
				this.registration = undefined;
				return "working";
			}
			this.needsAttention(turn.eventId);
			return "needs_attention";
		}
	}

	private async recover(): Promise<void> {
		for (const turn of this.journal.read().turns) {
			if (turn.state !== "starting" && turn.state !== "running") continue;
			let worker = turn.worker ? readWorkerState(turn.worker.statePath) : undefined;
			if (!worker && turn.worker) { await delay(500); worker = readWorkerState(turn.worker.statePath); }
			if (!worker) { this.needsAttention(turn.eventId); continue; }
			if (turn.worker?.cancelRequested) { await this.settleCancellation(turn.eventId, turn.worker.statePath); continue; }
			if (worker.status === "terminal" && worker.terminal) { this.importTerminal(turn.eventId, worker.terminal); continue; }
			if (worker.status === "needs_attention" || !await ownsProcessIdentity(worker.workerPid, worker.workerIdentity)) {
				if (await this.hasProcessWitness(worker)) await quiesceProcessGroup(worker.workerPid);
				this.needsAttention(turn.eventId);
				continue;
			}
			this.replaceTurn(turn.eventId, (current) => ({ ...current, state: "running", worker: { attempt: worker!.attempt, statePath: turn.worker!.statePath, workerPid: worker!.workerPid, workerIdentity: worker!.workerIdentity, ...(turn.worker!.cancelRequested === undefined ? {} : { cancelRequested: turn.worker!.cancelRequested }) }, updatedAt: Date.now() }));
		}
	}

	private confirmAdmission(claimId: string): void { this.update((state) => ({ ...state, admissions: state.admissions.map((item) => item.claimId === claimId ? { ...item, ack: "confirmed" } : item) })); }
	private async settleCancellation(eventId: string, statePath: string): Promise<void> { const worker = readWorkerState(statePath); if (worker?.status === "terminal" && worker.terminal) { this.importTerminal(eventId, worker.terminal); return; } if (!worker || !await this.hasProcessWitness(worker) || !await quiesceProcessGroup(worker.workerPid)) { this.needsAttention(eventId); return; } const terminal = readWorkerState(statePath)?.terminal ?? { status: "cancelled" as const, body: "Bridge turn cancelled after exact worker-group quiescence.", sessionAdvance: worker.childPid ? "uncertain" as const : "none" as const }; this.setReplyPending(eventId, terminal); }
	private importTerminal(eventId: string, terminal: NonNullable<BridgeTurn["terminal"]>): void { if (this.rejectUncertainNativeSession(eventId, terminal)) return; this.update((state) => ({ ...state, ...(terminal.sessionId ? { driverSessionId: terminal.sessionId } : {}), turns: state.turns.map((turn) => turn.eventId === eventId ? { ...turn, state: "terminal", terminal, updatedAt: Date.now() } : turn) })); }
	private setReplyPending(eventId: string, terminal: NonNullable<BridgeTurn["terminal"]>): void { if (this.rejectUncertainNativeSession(eventId, terminal)) return; this.update((state) => ({ ...state, ...(terminal.sessionId ? { driverSessionId: terminal.sessionId } : {}), turns: state.turns.map((turn) => turn.eventId === eventId ? { ...turn, state: "reply_pending", terminal, replyBody: terminal.body, reply: "unsent", updatedAt: Date.now() } : turn) })); }
	private rejectUncertainNativeSession(eventId: string, terminal: NonNullable<BridgeTurn["terminal"]>): boolean { if (this.config.driver === "fake" || terminal.sessionAdvance !== "uncertain") return false; this.update((state) => ({ ...state, status: "needs_attention", turns: state.turns.map((turn) => turn.eventId === eventId ? { ...turn, state: "needs_attention", terminal, updatedAt: Date.now() } : turn) })); return true; }
	private needsAttention(eventId: string): void { this.update((state) => ({ ...state, status: "needs_attention", turns: state.turns.map((turn) => turn.eventId === eventId ? { ...turn, state: "needs_attention", updatedAt: Date.now() } : turn) })); }
	private async hasProcessWitness(worker: BridgeWorkerState): Promise<boolean> { return await ownsProcessIdentity(worker.workerPid, worker.workerIdentity) || Boolean(worker.childPid && worker.childIdentity && await ownsProcessIdentity(worker.childPid, worker.childIdentity)); }
	private replaceTurn(eventId: string, update: (turn: BridgeTurn) => BridgeTurn): void { this.update((state) => ({ ...state, turns: state.turns.map((turn) => turn.eventId === eventId ? update(turn) : turn) })); }
	private update(update: (state: BridgeJournal) => BridgeJournal): BridgeJournal {
		const state = this.journal.update((current) => ({ ...compactSettled(update(current)), updatedAt: Date.now() }));
		this.journal.pruneTurnArtifacts(state.turns.map((turn) => turn.turnId));
		return state;
	}
	private requireRegistration(): RuntimeRegistration { if (!this.registration) throw new Error("Bridge runner is not registered."); return this.registration; }
}

function compactSettled(state: BridgeJournal): BridgeJournal {
	if (state.turns.length <= RETAINED_SETTLED_TURNS) return state;
	const turns = new Map(state.turns.map((turn) => [turn.eventId, turn]));
	const uncertain = new Set(state.admissions.filter((admission) => admission.ack === "uncertain").flatMap((admission) => admission.eventIds));
	const settled = state.admissions
		.filter((admission) => admission.ack === "confirmed" && admission.eventIds.every((eventId) => !uncertain.has(eventId) && turns.get(eventId)?.state === "reply_sent"))
		.sort((left, right) => Math.max(...left.eventIds.map((eventId) => turns.get(eventId)!.sequence)) - Math.max(...right.eventIds.map((eventId) => turns.get(eventId)!.sequence)));
	const removed = new Set<string>();
	let remaining = state.turns.length;
	for (const admission of settled) {
		if (remaining <= RETAINED_SETTLED_TURNS) break;
		for (const eventId of admission.eventIds) if (!removed.has(eventId)) { removed.add(eventId); remaining--; }
	}
	if (!removed.size) return state;
	return {
		...state,
		admissions: state.admissions.filter((admission) => admission.ack !== "confirmed" || admission.eventIds.some((eventId) => !removed.has(eventId))),
		turns: state.turns.filter((turn) => !removed.has(turn.eventId)),
	};
}

function parseRegistration(value: unknown, config: BridgeRunnerConfig): RuntimeRegistration {
	const item = object(value);
	if (config.driver !== "fake" && (item.profile !== config.profile || item.configurationHash !== config.configurationHash || item.projectRoot !== config.projectRoot || item.cwd !== config.cwd)) throw new Error("Bridge registration authority does not match the runner configuration.");
	return { targetKey: text(item.targetKey), registrationId: text(item.registrationId), registrationKey: text(item.registrationKey), participantKey: text(item.participantKey), holderGeneration: text(item.holderGeneration) };
}

function parseClaim(value: unknown): { claimId: string; eventIds: string[]; events: ClaimEvent[] } {
	const item = object(value);
	if (!Array.isArray(item.events)) throw new Error("Bridge claim events are invalid.");
	const events = item.events.map((value) => {
		const event = object(value);
		const payload = object(event.payload);
		const type = event.type;
		if (type !== "mailbox.message" && type !== "mailbox.task") throw new Error("Bridge runner accepts mailbox message or task events only.");
		return { eventId: text(event.eventId), type: type as ClaimEvent["type"], payload: { senderParticipantKey: text(payload.senderParticipantKey), body: boundedBody(payload.body) } };
	});
	const eventIds = events.map((event) => event.eventId);
	return { claimId: text(item.claimId), eventIds, events };
}

async function currentHerdrIdentity(): Promise<{ paneId: string; terminalId: string }> {
	const { execFile } = await import("node:child_process");
	return new Promise((resolve, reject) => execFile("herdr", ["pane", "current", "--current"], { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
		if (error) { reject(new Error("Herdr bridge pane identity is unavailable.")); return; }
		try { const pane = object(object(JSON.parse(stdout)).result).pane as Record<string, unknown>; resolve({ paneId: text(pane.pane_id), terminalId: text(pane.terminal_id) }); } catch { reject(new Error("Herdr bridge pane identity is malformed.")); }
	}));
}

function auth(registration: RuntimeRegistration): { registrationId: string; registrationKey: string } { return { registrationId: registration.registrationId, registrationKey: registration.registrationKey }; }
function replySendId(bridgeId: string, eventId: string): string { return `reply_${createHash("sha256").update("bridge-reply\0").update(bridgeId).update("\0").update(eventId).digest("hex").slice(0, 48)}`; }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object."); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("Expected non-empty text."); return value; }
function boundedBody(value: unknown): string { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > BRIDGE_RUNNER_MAX_BODY_BYTES) throw new Error("Bridge mailbox body is invalid."); return value; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitReady(child: ChildProcess, timeoutMs: number): Promise<{ workerPid: number; workerIdentity: string }> {
	return new Promise((resolve, reject) => {
		const finish = (error?: Error, value?: { workerPid: number; workerIdentity: string }) => { clearTimeout(timer); child.removeListener("error", onError); child.removeListener("exit", onExit); child.removeListener("message", onMessage); error ? reject(error) : resolve(value!); };
		const onError = (error: Error) => finish(error);
		const onExit = (code: number | null) => finish(new Error(`Bridge worker exited before ready (${code ?? "?"}).`));
		const onMessage = (message: unknown) => { const item = object(message); if (item.type === "bridge_worker_ready") finish(undefined, { workerPid: Number(item.workerPid), workerIdentity: text(item.workerIdentity) }); };
		const timer = setTimeout(() => finish(new Error("Bridge worker ready timeout.")), timeoutMs);
		child.once("error", onError);
		child.once("exit", onExit);
		child.on("message", onMessage);
	});
}
function authorizeWorkerStart(child: ChildProcess): Promise<void> { return new Promise((resolve, reject) => child.send({ type: "bridge_worker_start" }, (error) => error ? reject(error) : resolve())); }
