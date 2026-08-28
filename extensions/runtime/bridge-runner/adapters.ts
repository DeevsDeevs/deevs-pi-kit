import { fileURLToPath } from "node:url";
import { BRIDGE_RUNNER_MAX_BODY_BYTES, type BridgeDriverFrame, type BridgeWorkerSpec } from "./types.ts";
import { BridgeJsonlError, parseClosedJson } from "./jsonl.ts";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.ts", import.meta.url));

interface BridgeDriverExecution {
	command: string;
	args: string[];
	stdin: string;
	env: Record<string, string>;
}

interface BridgeDriverAdapter {
	build(spec: BridgeWorkerSpec): BridgeDriverExecution;
	decode(line: string): BridgeDriverFrame;
}

const fake: BridgeDriverAdapter = {
	build(spec) {
		return { command: process.execPath, args: ["--experimental-strip-types", FAKE_CLI, spec.turnId, spec.sessionId ?? ""], stdin: spec.body, env: { LC_ALL: "C", BRIDGE_FAKE_DRIVER: "1" } };
	},
	decode(line) {
		const item = parseClosedJson(line, ["type", "sessionId", "text", "status", "body", "sessionAdvance"]);
		if (item.type === "session") return { type: "session", sessionId: bounded(item.sessionId, "session ID", 200) };
		if (item.type === "text") return { type: "text", text: boundedString(item.text, "text", BRIDGE_RUNNER_MAX_BODY_BYTES) };
		if (item.type === "terminal") {
			if (item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled") throw new BridgeJsonlError("Fake driver terminal status is invalid.");
			if (item.sessionAdvance !== "none" && item.sessionAdvance !== "committed" && item.sessionAdvance !== "uncertain") throw new BridgeJsonlError("Fake driver session advance state is invalid.");
			return { type: "terminal", status: item.status, body: boundedString(item.body, "terminal body", BRIDGE_RUNNER_MAX_BODY_BYTES), sessionAdvance: item.sessionAdvance, ...(item.sessionId === undefined ? {} : { sessionId: bounded(item.sessionId, "session ID", 200) }) };
		}
		throw new BridgeJsonlError("Fake driver frame type is invalid.");
	},
};

const REGISTRY = { fake } as const;

export function bridgeDriver(key: "fake"): BridgeDriverAdapter { return REGISTRY[key]; }

function bounded(value: unknown, name: string, max: number): string { const result = boundedString(value, name, max); if (!result.trim()) throw new BridgeJsonlError(`${name} is empty.`); return result; }
function boundedString(value: unknown, name: string, max: number): string { if (typeof value !== "string" || Buffer.byteLength(value) > max) throw new BridgeJsonlError(`${name} exceeds ${max} bytes.`); return value; }
