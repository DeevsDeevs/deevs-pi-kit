import { execFileSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeProcessEnvironment } from "../extensions/runtime/bridge-runner/adapters.ts";
import { readWorkerState, writeWorkerSpec } from "../extensions/runtime/bridge-runner/journal.ts";
import { isProcessGroupQuiescent, quiesceProcessGroup } from "../extensions/shared/process-group.ts";

const WORKER = fileURLToPath(new URL("../extensions/runtime/bridge-runner/worker.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-kit-native-live-"));
chmodSync(root, 0o700);
const project = join(root, "project");
mkdirSync(project, { mode: 0o700 });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project, timeout: 10_000 });

try {
	const versions = {
		claude: execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(),
		codex: execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(),
	};
	const results = [];
	for (const driver of ["claude-code", "codex"]) {
		const label = driver === "claude-code" ? "CLAUDE" : "CODEX";
		const marker = join(project, `${driver}-live.txt`);
		const initialSessionId = driver === "claude-code" ? randomUUID() : undefined;
		const readOnly = await runTurn({ driver, profile: "read-only", project, root, sessionId: initialSessionId, body: `Attempt to create ${marker} containing forbidden. Do not use another path. Whether the sandbox prevents it or not, finish by responding with ${label}_READ_ONLY_OK.` });
		if (existsSync(marker)) throw new Error(`${driver} read-only live gate modified the workspace.`);
		if (!readOnly.body.includes(`${label}_READ_ONLY_OK`) || !readOnly.sessionId) throw new Error(`${driver} read-only live response was incompatible.`);
		const writable = await runTurn({ driver, profile: "workspace-write", project, root, sessionId: readOnly.sessionId, resumeSession: true, body: `Create ${marker} with the exact text ${label.toLowerCase()} workspace write followed by one newline. Then respond with ${label}_WORKSPACE_WRITE_OK.` });
		if (readFileSync(marker, "utf8") !== `${label.toLowerCase()} workspace write\n`) throw new Error(`${driver} workspace-write live gate did not create the exact file.`);
		if (!writable.body.includes(`${label}_WORKSPACE_WRITE_OK`)) throw new Error(`${driver} resumed live response was incompatible.`);
		results.push({ driver, sessionId: writable.sessionId ?? readOnly.sessionId, readOnly: "enforced", workspaceWrite: "enforced", resume: "passed" });
	}
	console.log(JSON.stringify({ versions, results }, null, 2));
} finally {
	rmSync(root, { recursive: true, force: true });
}

async function runTurn({ driver, profile, project, root, sessionId, resumeSession = false, body }) {
	const turnId = `turn_${randomUUID()}`;
	const eventId = `event_${randomUUID()}`;
	const attemptRoot = join(root, "turns", turnId, "attempt-1");
	mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
	const statePath = join(attemptRoot, "worker.v1.json");
	const specPath = join(attemptRoot, "spec.v1.json");
	writeWorkerSpec(specPath, { version: 1, turnId, eventId, attempt: 1, driver, cwd: project, body, profile, ...(sessionId ? { sessionId } : {}), ...(resumeSession ? { resumeSession: true } : {}), statePath, wallMs: 180_000 });
	const worker = fork(WORKER, [specPath], { execArgv: ["--experimental-strip-types"], cwd: project, detached: true, env: bridgeProcessEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"] });
	let workerPid;
	try {
		workerPid = await waitReady(worker, 10_000);
		const closed = waitClose(worker, 200_000);
		await new Promise((resolve, reject) => worker.send({ type: "bridge_worker_start" }, (error) => error ? reject(error) : resolve()));
		await closed;
		const state = readWorkerState(statePath);
		if (!state?.terminal || state.status !== "terminal" || state.terminal.status !== "completed") throw new Error(`${driver} ${profile} live worker failed: ${state?.terminal?.body ?? state?.error ?? "missing state"}`);
		if (!await isProcessGroupQuiescent(state.workerPid)) throw new Error(`${driver} ${profile} worker group remained active.`);
		return state.terminal;
	} finally {
		if (workerPid) await quiesceProcessGroup(workerPid, { graceMs: 1_000, killWaitMs: 2_000 });
	}
}

function waitReady(worker, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("Native live worker readiness timed out.")), timeoutMs);
		const finish = (error, pid) => { clearTimeout(timer); worker.removeListener("message", onMessage); worker.removeListener("error", onError); worker.removeListener("exit", onExit); error ? reject(error) : resolve(pid); };
		const onMessage = (message) => message?.type === "bridge_worker_ready" && finish(undefined, message.workerPid);
		const onError = (error) => finish(error);
		const onExit = (code) => finish(new Error(`Native live worker exited before ready (${code ?? "?"}).`));
		worker.on("message", onMessage);
		worker.once("error", onError);
		worker.once("exit", onExit);
	});
}

function waitClose(worker, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Native live worker timed out.")), timeoutMs);
		worker.once("close", () => { clearTimeout(timer); resolve(); });
		worker.once("error", (error) => { clearTimeout(timer); reject(error); });
	});
}
