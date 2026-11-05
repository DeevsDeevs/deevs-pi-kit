import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chainsExtension from "../extensions/chains/index.ts";

afterEach(() => vi.unstubAllEnvs());

type Handler = (event: unknown, ctx: { cwd: string }) => void;

function session(cwd: string, append: string): string {
	const handlers: Record<string, Handler> = {};
	chainsExtension({ on: (name: string, fn: Handler) => { handlers[name] = fn; } } as unknown as ExtensionAPI);
	handlers.session_start({ type: "session_start", reason: "startup" }, { cwd });
	const event = { systemPromptOptions: { appendSystemPrompt: append } };
	handlers.before_agent_start(event, { cwd });
	handlers.before_agent_start(event, { cwd });
	return event.systemPromptOptions.appendSystemPrompt;
}

function home(script?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-chains-"));
	if (script) {
		mkdirSync(join(dir, ".agents/skills/chains"), { recursive: true });
		writeFileSync(join(dir, ".agents/skills/chains/chain.mjs"), script);
	}
	vi.stubEnv("HOME", dir);
	return dir;
}

it("appends the chains digest once, for the session's folder", () => {
	const cwd = home(`if (process.argv.slice(2).join(" ") === "list --max 5") console.log("Chains in " + process.cwd());`);
	expect(session(cwd, "user text")).toBe(`user text\n\nChains in ${cwd}`);
});

it("adds nothing without the skill, with an empty digest, from an older chain.mjs, or when the script fails", () => {
	expect(session(home(), "")).toBe("");
	expect(session(home(`process.exit(0);`), "")).toBe("");
	expect(session(home(`console.log("no chains in " + process.cwd());`), "")).toBe("");
	expect(session(home(`console.log("usage"); process.exit(1);`), "")).toBe("");
});
