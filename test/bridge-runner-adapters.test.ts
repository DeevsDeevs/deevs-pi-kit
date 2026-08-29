import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bridgeDriver, bridgeProcessEnvironment } from "../extensions/runtime/bridge-runner/adapters.ts";
import type { BridgeWorkerSpec } from "../extensions/runtime/bridge-runner/types.ts";

const persona = { name: "reviewer", prompt: "Review only the requested change.", promptHash: createHash("sha256").update("Review only the requested change.").digest("hex") };
const spec = (driver: BridgeWorkerSpec["driver"], extra: Partial<BridgeWorkerSpec> = {}): BridgeWorkerSpec => ({ version: 1, turnId: "turn_1", eventId: "event_1", attempt: 1, driver, cwd: process.cwd(), body: "Inspect this.", statePath: "/tmp/worker.json", wallMs: 1_000, ...extra });

describe("native bridge adapters", () => {
	it("passes only the explicit process environment needed by native CLIs", () => {
		const environment = bridgeProcessEnvironment();
		expect(environment.PATH).toBeTruthy();
		expect(environment.HOME).toBe(process.env.HOME);
		expect(Object.keys(environment).some((key) => key.startsWith("PI_") || key.endsWith("API_KEY"))).toBe(false);
	});

	it("builds a restricted Claude Code turn and decodes its typed result", () => {
		const adapter = bridgeDriver("claude-code");
		const execution = adapter.build(spec("claude-code", { profile: "workspace-write", model: "haiku", persona, sessionId: "82234b5c-a7d8-4e3f-95fa-89d1704121dc" }));
		expect(execution.command).toBe("claude");
		expect(execution.args).toContain("--safe-mode");
		expect(execution.args).toContain("acceptEdits");
		expect(execution.args).toContain("Read,Glob,Grep,Edit,Write");
		expect(execution.args).not.toContain("Bash");
		expect(execution.args).toContain("--session-id");
		expect(execution.args).toContain("--append-system-prompt");
		expect(execution.env).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(decodeFixture(adapter, "claude-code-2.1.220-success.jsonl")).toEqual([
			{ type: "session", sessionId: "7f56ddde-9570-45a8-adcf-4f606bd27bce" },
			{ type: "terminal", status: "completed", body: "FIXTURE_CLAUDE_OK", sessionAdvance: "committed", sessionId: "7f56ddde-9570-45a8-adcf-4f606bd27bce" },
		]);
	});

	it("resumes Claude Code without re-injecting the persona", () => {
		const execution = bridgeDriver("claude-code").build(spec("claude-code", { profile: "read-only", persona, sessionId: "82234b5c-a7d8-4e3f-95fa-89d1704121dc", resumeSession: true }));
		expect(execution.args).toContain("--resume");
		expect(execution.args).toContain("dontAsk");
		expect(execution.args).not.toContain("--append-system-prompt");
		expect(execution.args).toContain("Read,Glob,Grep");
	});

	it("builds sandboxed Codex turns and decodes session, text, and terminal frames", () => {
		const adapter = bridgeDriver("codex");
		const execution = adapter.build(spec("codex", { profile: "workspace-write", model: "gpt-5.4-mini", persona, sessionId: "01a04ab9-d071-74b3-86e8-d55bea4ece5c", resumeSession: true }));
		expect(execution.command).toBe("codex");
		expect(execution.args.slice(0, 5)).toEqual(["--ask-for-approval", "never", "--sandbox", "workspace-write", "exec"]);
		expect(execution.args).toContain("resume");
		expect(execution.args).toContain("--ignore-user-config");
		expect(execution.args).toContain("--strict-config");
		expect(execution.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(execution.env).not.toHaveProperty("OPENAI_API_KEY");
		expect(decodeFixture(adapter, "codex-0.145.0-success.jsonl")).toEqual([
			{ type: "session", sessionId: "01a04adf-ef61-7bb0-b19a-505a4c791489" },
			{ type: "text", text: "FIXTURE_CODEX_OK" },
			{ type: "terminal", status: "completed", body: "", sessionAdvance: "committed" },
		]);
	});

	it("fails closed on malformed recognized native frames", () => {
		expect(() => bridgeDriver("claude-code").decode(JSON.stringify({ type: "result", subtype: "success", is_error: false }))).toThrow();
		expect(() => bridgeDriver("codex").decode(JSON.stringify({ type: "thread.started", thread_id: "" }))).toThrow();
	});
});

function decodeFixture(adapter: ReturnType<typeof bridgeDriver>, name: string) {
	return readFileSync(new URL(`./fixtures/native/${name}`, import.meta.url), "utf8").trim().split("\n").map((line) => adapter.decode(line)).filter(Boolean);
}
