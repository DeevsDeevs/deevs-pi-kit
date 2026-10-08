import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = join(ROOT, "plugins/chains");

function project(): string {
	return mkdtempSync(join(tmpdir(), "chains-plugin-"));
}

function mcp(cwd: string, requests: object[]): Array<{ id: number; result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }> {
	const input = requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n");
	const run = spawnSync("node", [join(PLUGIN, "server/mcp.mjs")], { input: `${input}\n`, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });
	expect(run.stderr).toBe("");
	return run.stdout.trim().split("\n").map((line) => JSON.parse(line));
}

function hook(input: object, env: Record<string, string> = {}): { hookSpecificOutput?: { additionalContext?: string }; decision?: string; reason?: string } | undefined {
	const run = spawnSync("node", [join(PLUGIN, "server/hook.mjs")], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env } });
	expect(run.stderr).toBe("");
	return run.stdout ? JSON.parse(run.stdout) : undefined;
}

describe("chains plugin for Claude Code and Codex", () => {
	it("ships exactly the Pi chain core (run npm run sync:chains-plugin after editing it)", () => {
		const files = readdirSync(join(PLUGIN, "lib"), { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
		expect(files.sort()).toEqual(["chains/format.ts", "chains/parser.ts", "chains/service.ts", "chains/tool.ts", "chains/types.ts", "shared/bytes.ts", "shared/terms.ts"]);
		for (const file of files) {
			expect({ file, same: readFileSync(join(PLUGIN, "lib", file), "utf8") === readFileSync(join(ROOT, "extensions", file), "utf8") }).toEqual({ file, same: true });
		}
	});

	it("is listed by the repository marketplace and declares its MCP server and hooks", () => {
		const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
		const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === "chains");
		expect(existsSync(join(ROOT, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(PLUGIN, ".mcp.json"), "utf8")).mcpServers.chains.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs"]);
		expect(Object.keys(JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks)).toEqual(["SessionStart", "Stop"]);
	});

	it("serves the Pi chain tool over stdio and writes links Pi can read", () => {
		const cwd = project();
		const [init, list, save, load] = mcp(cwd, [
			{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
			{ method: "notifications/initialized" },
			{ id: 2, method: "tools/list" },
			{ id: 3, method: "tools/call", params: { name: "chain", arguments: { action: "save", chain: "demo", title: "First", content: "# First\n\nDone.", nextStep: "Ship" } } },
			{ id: 4, method: "tools/call", params: { name: "chain", arguments: { action: "load", chain: "demo" } } },
		]);
		expect(init?.id).toBe(1);
		expect(list?.result?.tools?.map((tool) => tool.name)).toEqual(["chain"]);
		expect(save?.result?.content?.[0]?.text).toContain(join(cwd, ".chains/demo/"));
		expect(load?.result?.content?.[0]?.text).toContain("Next step: Ship");
		const [missing, badMode, noAction] = mcp(cwd, [
			{ id: 5, method: "tools/call", params: { name: "chain", arguments: { action: "load", chain: "absent" } } },
			{ id: 6, method: "tools/call", params: { name: "chain", arguments: { action: "context", chain: "demo", mode: "full" } } },
			{ id: 7, method: "tools/call", params: { name: "chain", arguments: { chain: "demo" } } },
		]);
		expect(missing?.result?.isError).toBe(true);
		expect([badMode?.result?.isError, badMode?.result?.content?.[0]?.text]).toEqual([true, "mode must be one of pack, latest."]);
		expect(noAction?.result?.content?.[0]?.text).toMatch(/^action must be one of save, load/);
	});

	it("refuses one stop at 80% context as the only reminder, unless a link was written since use was last below the line", () => {
		const cwd = project();
		const data = { CLAUDE_PLUGIN_DATA: join(cwd, "data"), CHAINS_CONTEXT_WINDOW: "200000" };
		const claude = join(cwd, "claude.jsonl");
		const use = (path: string, cacheRead: number) => writeFileSync(path, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } } })}\n`);
		const stop = (session_id: string, extra: object = {}, env: Record<string, string> = {}) => hook({ hook_event_name: "Stop", cwd, session_id, transcript_path: claude, ...extra }, { ...data, ...env });
		use(claude, 100_000);
		expect(stop("claude")).toBeUndefined();
		use(claude, 170_000);
		expect(stop("claude")).toMatchObject({ decision: "block", reason: expect.stringContaining("Context is at 85%") });
		expect(stop("claude", { stop_hook_active: true })).toBeUndefined();
		expect(stop("claude")).toBeUndefined();
		use(claude, 100_000);
		expect(stop("claude")).toBeUndefined();
		use(claude, 170_000);
		expect(stop("claude")?.decision).toBe("block");

		use(claude, 100_000);
		expect(stop("saved")).toBeUndefined();
		mkdirSync(join(cwd, ".chains/demo"), { recursive: true });
		const link = join(cwd, ".chains/demo/2026-09-01-000000000-saved.md");
		writeFileSync(link, "# Saved\n");
		const later = new Date(Date.now() + 1000);
		utimesSync(link, later, later);
		use(claude, 170_000);
		expect(stop("saved", { cwd: join(cwd, "src") }, { CLAUDE_PROJECT_DIR: cwd })).toBeUndefined();

		const fresh = project();
		const codex = join(fresh, "codex.jsonl");
		const codexStop = () => hook({ hook_event_name: "Stop", cwd: fresh, session_id: "codex", transcript_path: codex }, data);
		writeFileSync(codex, `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100_000 }, model_context_window: 258_400 } } })}\n`);
		expect(codexStop()).toBeUndefined();
		writeFileSync(codex, `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 220_000 }, model_context_window: 258_400 } } })}\n`);
		expect(codexStop()?.decision).toBe("block");
	});

	it("points a new session at the latest link and hands the link back after compaction", () => {
		const cwd = project();
		expect(hook({ hook_event_name: "SessionStart", source: "startup", cwd, session_id: "s" })).toBeUndefined();
		mcp(cwd, [{ id: 1, method: "tools/call", params: { name: "chain", arguments: { action: "save", chain: "demo", title: "Latest work", content: "# Latest work\n\nDetails here.", nextStep: "Ship it" } } }]);
		expect(hook({ hook_event_name: "SessionStart", source: "startup", cwd, session_id: "s" })?.hookSpecificOutput?.additionalContext).toContain('Latest: demo@main "Latest work". Next step: Ship it.');
		const resumed = hook({ hook_event_name: "SessionStart", source: "compact", cwd, session_id: "s" })?.hookSpecificOutput?.additionalContext;
		expect(resumed).toContain("Context was compacted");
		expect(resumed).toContain("Details here.");
	});
});
