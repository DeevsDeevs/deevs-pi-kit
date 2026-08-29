import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { bridgeDriver } from "./adapters.ts";
import { BoundedJsonlDecoder } from "./jsonl.ts";
import { readProcessIdentity } from "../../shared/process-group.ts";
import { readWorkerState, writeWorkerState } from "./journal.ts";
import { BRIDGE_RUNNER_MAX_FRAMES, BRIDGE_RUNNER_MAX_STDERR_BYTES, type BridgeDriverFrame, type BridgeTurnTerminal, type BridgeWorkerSpec, type BridgeWorkerState } from "./types.ts";

const specPath = process.argv[2];
if (!specPath) throw new Error("Bridge worker requires a spec path.");
const spec = validateSpec(JSON.parse(readFileSync(specPath, "utf8")));
let child: ChildProcessWithoutNullStreams | undefined;
let cancelRequested = false;
let groupStopping = false;
let protocolError: string | undefined;
let terminal: BridgeTurnTerminal | undefined;
let sessionId = spec.sessionId;
let stderrBytes = 0;
let stderrText = "";
let killTimer: NodeJS.Timeout | undefined;
let frames = 0;
let outputText = "";
const startedAt = Date.now();
const workerIdentity = await readProcessIdentity(process.pid);
if (!workerIdentity) throw new Error("Bridge worker process identity is unavailable.");
let state: BridgeWorkerState = { version: 1, turnId: spec.turnId, eventId: spec.eventId, attempt: spec.attempt, status: "starting", workerPid: process.pid, workerIdentity, stdoutBytes: 0, stderrBytes: 0, frames: 0, startedAt, updatedAt: startedAt };
const startAuthorization = waitForStartAuthorization();
persist();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, requestCancel);
process.send?.({ type: "bridge_worker_ready", workerPid: process.pid, workerIdentity });
try { await startAuthorization; }
catch (error) {
	const body = error instanceof Error ? error.message : String(error);
	persist({ status: "terminal", terminal: { status: "failed", body, sessionAdvance: "none" }, error: body, endedAt: Date.now() });
	process.exit(1);
}
process.disconnect?.();

function persist(patch: Partial<BridgeWorkerState> = {}): void {
	state = { ...state, ...patch, updatedAt: Date.now() };
	writeWorkerState(spec.statePath, state);
}

function acceptFrame(frame: BridgeDriverFrame): void {
	frames++;
	if (frames > BRIDGE_RUNNER_MAX_FRAMES) throw new Error(`Bridge frame count exceeds ${BRIDGE_RUNNER_MAX_FRAMES}.`);
	if (frame.type === "session") sessionId = frame.sessionId;
	if (frame.type === "text") outputText = frame.text;
	if (frame.type === "terminal") {
		if (terminal) throw new Error("Bridge driver emitted more than one terminal frame.");
		terminal = { status: frame.status, body: frame.body || outputText || "Native turn completed without display text.", sessionAdvance: frame.sessionAdvance, ...(frame.sessionId ?? sessionId ? { sessionId: frame.sessionId ?? sessionId } : {}) };
	}
	persist({ frames, terminal });
}

function requestCancel(): void {
	if (groupStopping) return;
	cancelRequested = true;
	stopGroup();
}

function requestFailure(): void {
	if (!groupStopping) stopGroup();
}

function stopGroup(): void {
	groupStopping = true;
	try { process.kill(-process.pid, "SIGTERM"); } catch {}
	killTimer = setTimeout(() => {
		try { persist({ status: "needs_attention", error: "Bridge worker group did not stop after termination." }); } catch {}
		try { process.kill(-process.pid, "SIGKILL"); } catch {}
	}, 500);
	killTimer.unref?.();
}

try {
	const driver = bridgeDriver(spec.driver);
	const execution = driver.build(spec);
	const decoder = new BoundedJsonlDecoder((line) => {
		try { const frame = driver.decode(line); if (frame) acceptFrame(frame); }
		catch (error) { protocolError = error instanceof Error ? error.message : String(error); requestFailure(); }
	});
	if (groupStopping) throw new Error(cancelRequested ? "Bridge worker was cancelled before native spawn." : "Bridge worker stopped before native spawn.");
	child = spawn(execution.command, execution.args, { cwd: spec.cwd, env: execution.env, detached: false, stdio: ["pipe", "pipe", "pipe"] });
	if (!child.pid) throw new Error("Bridge native child has no PID.");
	if (groupStopping) try { process.kill(-process.pid, "SIGTERM"); } catch {}
	const childIdentity = await readProcessIdentity(child.pid);
	if (!childIdentity) { child.kill("SIGKILL"); throw new Error("Bridge native child identity is unavailable."); }
	persist({ status: "running", childPid: child.pid, childIdentity });
	child.stdout.on("data", (chunk: Buffer) => {
		if (protocolError) return;
		try { decoder.push(chunk); persist({ stdoutBytes: state.stdoutBytes + chunk.length }); }
		catch (error) { protocolError = error instanceof Error ? error.message : String(error); requestFailure(); }
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes <= BRIDGE_RUNNER_MAX_STDERR_BYTES) stderrText += chunk.toString("utf8");
		else { protocolError = `Bridge stderr exceeds ${BRIDGE_RUNNER_MAX_STDERR_BYTES} bytes.`; requestFailure(); }
		persist({ stderrBytes: Math.min(stderrBytes, BRIDGE_RUNNER_MAX_STDERR_BYTES) });
	});
	child.stdin.end(execution.stdin);
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child!.once("close", (code, signal) => resolve({ code, signal })));
	const wall = setTimeout(requestCancel, spec.wallMs);
	wall.unref?.();
	const result = await closed;
	clearTimeout(wall);
	if (killTimer) clearTimeout(killTimer);
	child.stdout.destroy();
	child.stderr.destroy();
	try { decoder.end(); } catch (error) { protocolError ??= error instanceof Error ? error.message : String(error); }
	if (!terminal) terminal = { status: cancelRequested ? "cancelled" : "failed", body: protocolError || stderrText.trim().slice(0, 16 * 1024) || `Native process exited without a terminal frame (code ${result.code ?? "?"}).`, sessionAdvance: state.childPid ? "uncertain" : "none", ...(sessionId ? { sessionId } : {}) };
	else if (protocolError) terminal = { status: "failed", body: protocolError, sessionAdvance: "uncertain", ...(terminal.sessionId ? { sessionId: terminal.sessionId } : {}) };
	else if (cancelRequested) { /* a validated terminal wins over later cancellation */ }
	else if (result.code === 0 && terminal.status === "completed") { /* structured completion wins */ }
	else if (terminal.status === "completed") terminal = { ...terminal, status: "failed", body: stderrText.trim().slice(0, 16 * 1024) || `Native process exited with code ${result.code ?? "?"}.` };
	persist({ status: "terminal", terminal, endedAt: Date.now(), error: protocolError });
	try { process.kill(-process.pid, "SIGKILL"); } catch {}
} catch (error) {
	const prior = readWorkerState(spec.statePath);
	const uncertain = Boolean(prior?.childPid);
	persist({ status: "terminal", terminal: { status: cancelRequested ? "cancelled" : "failed", body: error instanceof Error ? error.message : String(error), sessionAdvance: uncertain ? "uncertain" : "none", ...(sessionId ? { sessionId } : {}) }, error: error instanceof Error ? error.message : String(error), endedAt: Date.now() });
	if (child?.pid || groupStopping) try { process.kill(-process.pid, "SIGKILL"); } catch {}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(signal, requestCancel);

function waitForStartAuthorization(): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Bridge worker start authorization timed out.")), 10_000);
		const cleanup = () => { clearTimeout(timer); process.removeListener("message", onMessage); process.removeListener("disconnect", onDisconnect); };
		const onMessage = (message: unknown) => {
			if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "bridge_worker_start") return;
			cleanup();
			resolve();
		};
		const onDisconnect = () => { cleanup(); reject(new Error("Bridge worker controller disconnected before start authorization.")); };
		process.on("message", onMessage);
		process.once("disconnect", onDisconnect);
	});
}

function validateSpec(value: unknown): BridgeWorkerSpec {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Bridge worker spec must be an object.");
	const item = value as Record<string, unknown>;
	const allowed = ["version", "turnId", "eventId", "attempt", "driver", "cwd", "body", "profile", "model", "persona", "sessionId", "resumeSession", "statePath", "wallMs"];
	if (Object.keys(item).some((key) => !allowed.includes(key)) || item.version !== 1 || !["fake", "claude-code", "codex"].includes(String(item.driver))) throw new Error("Bridge worker spec is invalid.");
	for (const key of ["turnId", "eventId", "cwd", "body", "statePath"] as const) if (typeof item[key] !== "string") throw new Error(`Bridge worker ${key} is invalid.`);
	if (!Number.isSafeInteger(item.attempt) || Number(item.attempt) < 1 || !Number.isSafeInteger(item.wallMs) || Number(item.wallMs) < 1 || (item.resumeSession !== undefined && typeof item.resumeSession !== "boolean")) throw new Error("Bridge worker limits are invalid.");
	if (item.driver !== "fake" && item.profile !== "read-only" && item.profile !== "workspace-write") throw new Error("Native bridge worker profile is invalid.");
	if (item.model !== undefined && (typeof item.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/*:-]{0,199}$/.test(item.model))) throw new Error("Bridge worker model is invalid.");
	if (item.persona !== undefined) {
		if (!item.persona || typeof item.persona !== "object" || Array.isArray(item.persona)) throw new Error("Bridge worker persona is invalid.");
		const persona = item.persona as Record<string, unknown>;
		if (Object.keys(persona).some((key) => !["name", "prompt", "promptHash"].includes(key)) || typeof persona.name !== "string" || typeof persona.prompt !== "string" || typeof persona.promptHash !== "string" || Buffer.byteLength(persona.prompt) > 32 * 1024 || createHash("sha256").update(persona.prompt).digest("hex") !== persona.promptHash) throw new Error("Bridge worker persona is invalid.");
	}
	if (item.driver === "claude-code" && typeof item.sessionId !== "string") throw new Error("Claude Code worker session ID is invalid.");
	if (item.resumeSession === true && typeof item.sessionId !== "string") throw new Error("Resumed bridge worker session ID is invalid.");
	return item as unknown as BridgeWorkerSpec;
}
