import { execFile } from "node:child_process";
import { readRunnerConfig } from "./journal.ts";
import { BridgeRunner } from "./runner.ts";

const configPath = process.argv[2];
if (!configPath) throw new Error("Bridge runner requires a config path.");
const config = readRunnerConfig(configPath);
const pane = await currentPane();
await report(pane.paneId, config.bridgeId, "working");
const runner = new BridgeRunner(configPath, config);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort(signal));
try {
	await runner.run(controller.signal);
	await report(pane.paneId, config.bridgeId, runner.state().status === "needs_attention" ? "blocked" : "idle");
} catch (error) {
	await report(pane.paneId, config.bridgeId, "blocked");
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

async function currentPane(): Promise<{ paneId: string; terminalId: string }> {
	const result = await run(["pane", "current", "--current"]);
	const pane = object(object(result).result).pane;
	const record = object(pane);
	return { paneId: text(record.pane_id), terminalId: text(record.terminal_id) };
}

async function report(paneId: string, bridgeId: string, state: "working" | "idle" | "blocked"): Promise<void> {
	const label = `bridge:${bridgeId}`;
	await run(["pane", "report-agent-session", paneId, "--source", "pi-kit-bridge", "--agent", label, "--agent-session-id", bridgeId]);
	await run(["pane", "report-agent", paneId, "--source", "pi-kit-bridge", "--agent", label, "--state", state === "blocked" ? "blocked" : state, "--agent-session-id", bridgeId]);
}

function run(args: string[]): Promise<unknown> {
	return new Promise((resolve, reject) => execFile("herdr", args, { encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
		if (error) { reject(new Error("Herdr bridge reporting failed.")); return; }
		if (!stdout.trim()) { resolve(undefined); return; }
		try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Herdr bridge response is invalid.")); }
	}));
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object."); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("Expected text."); return value; }
