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

function hook(input: object, env: Record<string, string> = {}): { hookSpecificOutput?: { permissionDecision?: string; additionalContext?: string }; decision?: string } | undefined {
	const run = spawnSync("node", [join(PLUGIN, "server/hook.mjs")], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, ...env } });
	expect(run.stderr).toBe("");
	return run.stdout ? JSON.parse(run.stdout) : undefined;
}

describe("chains plugin for Claude Code and Codex", () => {
	it("ships exactly the Pi chain core (run npm run sync:chains-plugin after editing it)", () => {
		const files = readdirSync(join(PLUGIN, "lib"), { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
		expect(files.sort()).toEqual(["chains/format.ts", "chains/parser.ts", "chains/service.ts", "chains/types.ts", "shared/bytes.ts", "shared/terms.ts"]);
		for (const file of files) {
			expect({ file, same: readFileSync(join(PLUGIN, "lib", file), "utf8") === readFileSync(join(ROOT, "extensions", file), "utf8") }).toEqual({ file, same: true });
		}
	});

	it("is listed by the repository marketplace and declares its MCP server and hooks", () => {
		const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8"));
		const entry = marketplace.plugins.find((plugin: { name: string }) => plugin.name === "chains");
		expect(existsSync(join(ROOT, entry.source, ".claude-plugin/plugin.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(PLUGIN, ".mcp.json"), "utf8")).mcpServers.chains.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs"]);
		expect(Object.keys(JSON.parse(readFileSync(join(PLUGIN, "hooks/hooks.json"), "utf8")).hooks)).toEqual(["SessionStart", "PreToolUse", "Stop"]);
	});

	it("serves the six Pi chain tools over stdio and writes links Pi can read", () => {
		const cwd = project();
		const [init, list, save, load] = mcp(cwd, [
			{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
			{ method: "notifications/initialized" },
			{ id: 2, method: "tools/list" },
			{ id: 3, method: "tools/call", params: { name: "chain_save", arguments: { chain: "demo", title: "First", content: "# First\n\nDone.", nextStep: "Ship" } } },
			{ id: 4, method: "tools/call", params: { name: "chain_load", arguments: { chain: "demo" } } },
		]);
		expect(init?.id).toBe(1);
		expect(list?.result?.tools?.map((tool) => tool.name)).toEqual(["chain_save", "chain_load", "chain_list", "chain_fork", "chain_context", "chain_search"]);
		expect(save?.result?.content?.[0]?.text).toContain(join(cwd, ".chains/demo/"));
		expect(load?.result?.content?.[0]?.text).toContain("Next step: Ship");
		const [missing] = mcp(cwd, [{ id: 5, method: "tools/call", params: { name: "chain_load", arguments: { chain: "absent" } } }]);
		expect(missing?.result?.isError).toBe(true);
	});

	it("refuses non-chain tools and one stop at 80% context until a link is written, for Claude and Codex transcripts", () => {
		const cwd = project();
		const data = { CLAUDE_PLUGIN_DATA: join(cwd, "data"), CHAINS_CONTEXT_WINDOW: "200000" };
		const claude = join(cwd, "claude.jsonl");
		writeFileSync(claude, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 170_000 } } })}\n`);
		const call = (tool_name: string) => hook({ hook_event_name: "PreToolUse", tool_name, cwd, session_id: "claude", transcript_path: claude }, data);
		expect(call("Bash")?.hookSpecificOutput?.permissionDecision).toBe("deny");
		expect(call("mcp__plugin_chains_chains__chain_save")).toBeUndefined();
		expect(hook({ hook_event_name: "Stop", cwd, session_id: "claude", transcript_path: claude }, data)?.decision).toBe("block");
		expect(hook({ hook_event_name: "Stop", stop_hook_active: true, cwd, session_id: "claude", transcript_path: claude }, data)).toBeUndefined();
		mkdirSync(join(cwd, ".chains/demo"), { recursive: true });
		const link = join(cwd, ".chains/demo/2026-09-01-000000000-saved.md");
		writeFileSync(link, "# Saved\n");
		const later = new Date(Date.now() + 1000);
		utimesSync(link, later, later);
		expect(call("Bash")).toBeUndefined();

		const fresh = project();
		const codex = join(fresh, "codex.jsonl");
		writeFileSync(codex, `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100_000 }, model_context_window: 258_400 } } })}\n`);
		expect(hook({ hook_event_name: "PreToolUse", tool_name: "shell", cwd: fresh, session_id: "codex", transcript_path: codex }, data)).toBeUndefined();
		writeFileSync(codex, `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 220_000 }, model_context_window: 258_400 } } })}\n`);
		expect(hook({ hook_event_name: "PreToolUse", tool_name: "shell", cwd: fresh, session_id: "codex", transcript_path: codex }, data)?.hookSpecificOutput?.permissionDecision).toBe("deny");
	});

	it("points a new session at the latest link and hands the link back after compaction", () => {
		const cwd = project();
		expect(hook({ hook_event_name: "SessionStart", source: "startup", cwd, session_id: "s" })).toBeUndefined();
		mcp(cwd, [{ id: 1, method: "tools/call", params: { name: "chain_save", arguments: { chain: "demo", title: "Latest work", content: "# Latest work\n\nDetails here.", nextStep: "Ship it" } } }]);
		expect(hook({ hook_event_name: "SessionStart", source: "startup", cwd, session_id: "s" })?.hookSpecificOutput?.additionalContext).toContain('Latest: demo@main "Latest work". Next step: Ship it.');
		const resumed = hook({ hook_event_name: "SessionStart", source: "compact", cwd, session_id: "s" })?.hookSpecificOutput?.additionalContext;
		expect(resumed).toContain("Context was compacted");
		expect(resumed).toContain("Details here.");
	});
});
