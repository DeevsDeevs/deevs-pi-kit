import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkerState, writeWorkerSpec } from "../extensions/runtime/bridge-runner/journal.ts";
import type { BridgeWorkerSpec } from "../extensions/runtime/bridge-runner/types.ts";

const WORKER = fileURLToPath(new URL("../extensions/runtime/bridge-runner/worker.ts", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function run(body: string) {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-bridge-worker-"));
	roots.push(root);
	mkdirSync(join(root, "turn"));
	const statePath = join(root, "turn", "worker.json");
	const specPath = join(root, "turn", "spec.json");
	const spec: BridgeWorkerSpec = { version: 1, turnId: "turn_1", eventId: "event_1", attempt: 1, driver: "fake", cwd: root, body, statePath, wallMs: 2_000 };
	writeWorkerSpec(specPath, spec);
	const child = fork(WORKER, [specPath], { execArgv: ["--experimental-strip-types"], detached: true, env: { LC_ALL: "C", SHOULD_NOT_REACH_NATIVE_SECRET: "hidden" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	await once(child, "message");
	child.send({ type: "bridge_worker_start" });
	await once(child, "exit");
	return readWorkerState(statePath)!;
}

describe("bridge turn worker", () => {
	it("publishes worker identity before one native process and strips controller secrets", async () => {
		const state = await run("secret-env");
		expect(state).toMatchObject({ status: "terminal", workerPid: expect.any(Number), workerIdentity: expect.any(String), childPid: expect.any(Number), childIdentity: expect.any(String), terminal: { status: "completed", body: "secret-free", sessionAdvance: "none" } });
	});

	it("requires a validated terminal frame even on exit zero", async () => {
		const state = await run("no-terminal");
		expect(state).toMatchObject({ status: "terminal", terminal: { status: "failed", sessionAdvance: "uncertain" } });
		expect(state.terminal?.body).toContain("without a terminal frame");
	});

	it("fails malformed JSONL with session-advance uncertainty", async () => {
		const state = await run("malformed");
		expect(state).toMatchObject({ status: "terminal", terminal: { status: "failed", sessionAdvance: "uncertain" } });
		expect(state.terminal?.body).toContain("valid JSON");
	});
});
