import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nativeMessagingLaunch } from "../extensions/runtime/mcp/native.ts";
import { toolDefinitions } from "../extensions/runtime/mcp/tools.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(driver: "claude-code" | "codex") {
	const root = mkdtempSync(join(tmpdir(), "native-messaging-config-"));
	roots.push(root);
	return { driver, root, targetKey: "target_native", clientGeneration: "agent_client_first", nodeExecutable: process.execPath, model: "configured-model", personaPrompt: "Selected persona context." };
}

it.each(["claude-code", "codex"] as const)("compiles %s native configuration without processes, credentials or permission overrides", driver => {
	const config = { ...input(driver), personaPrompt: "Selected persona\r\n\tcontext." };
	const launch = nativeMessagingLaunch(config);
	for (const arg of launch.args) expect(arg).not.toMatch(/\p{Cc}/u);
	expect(readdirSync(config.root)).toEqual([]);
	expect(launch.descriptorPath.startsWith(`${config.root}/messaging-`)).toBe(true);
	expect(launch.configurationHash).toMatch(/^[a-f0-9]{64}$/);
	expect(launch.serverName).toMatch(/^pi_kit_[a-f0-9]{24}$/);
	for (const tool of toolDefinitions) expect(`mcp__${launch.serverName}__${tool.name}`.length).toBeLessThanOrEqual(64);
	for (const flag of ["--safe-mode", "--restricted", "--tools", "--allowedTools", "--permission-mode", "--strict-mcp-config", "--ask-for-approval", "--disable", "--dangerously-bypass-permissions", "--dangerously-bypass-approvals-and-sandbox"]) expect(launch.args).not.toContain(flag);
	expect(launch.args[launch.args.indexOf("--model") + 1]).toBe(config.model);
	expect(launch.args.join("\n")).not.toContain("developer_instructions=");
	expect(launch.args.join("\n")).not.toContain("trust_level");
	const context = driver === "claude-code" ? launch.args[launch.args.indexOf("--append-system-prompt") + 1]! : launch.args.at(-1)!;
	expect(context).toContain("Selected persona context.");
	const skill = readFileSync(resolve("skills/collaborator-messaging/SKILL.md"), "utf8");
	expect(context).toContain(resolve("skills/collaborator-messaging/SKILL.md"));
	expect(context).not.toContain(skill.replace(/\s+/gu, " ").trim());
	expect(context).toContain("Wait for explicit operator input");
	expect(context).toContain("Before using messaging tools, read the shared skill");
	const hash = (content: string) => createHash("sha256").update(JSON.stringify({ version: 1, driver, profile: "workspace-write", policy: "native-user-configuration", args: launch.args, tools: toolDefinitions, skill: content })).digest("hex");
	expect(launch.configurationHash).toBe(hash(skill));
	expect(launch.configurationHash).not.toBe(hash(`${skill}\nChanged policy.`));
	expect(escapedCommandBytes(driver, launch.args)).toBeLessThanOrEqual(4000);
	expect(nativeMessagingLaunch({ ...config, personaPrompt: "Selected persona context." }).configurationHash).toBe(launch.configurationHash);
	if (driver === "claude-code") {
		const servers = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]!).mcpServers;
		expect(Object.keys(servers)).toEqual([launch.serverName]);
		expect(servers[launch.serverName]).toEqual({ command: realpathSync(process.execPath), args: [resolve("extensions/runtime/mcp/main.mjs"), launch.descriptorPath] });
	} else {
		expect(launch.args.slice(0, 2)).toEqual(["--sandbox", "workspace-write"]);
		expect(launch.args[launch.args.indexOf("--config") + 1]).toBe(`mcp_servers.${launch.serverName}={command=${JSON.stringify(realpathSync(process.execPath))},args=${JSON.stringify([resolve("extensions/runtime/mcp/main.mjs"), launch.descriptorPath])}}`);
		expect(launch.args.at(-2)).toBe("--");
	}
});

function escapedCommandBytes(driver: "claude-code" | "codex", args: string[]): number {
	return Buffer.byteLength([driver === "claude-code" ? "claude" : "codex", ...args].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" "));
}

it.each(["claude-code", "codex"] as const)("bounds the escaped %s launch command before authority or process creation", driver => {
	const config = input(driver);
	const initial = nativeMessagingLaunch(config);
	const remaining = 4000 - escapedCommandBytes(driver, initial.args);
	expect(remaining).toBeGreaterThan(0);
	const personaPrompt = config.personaPrompt + "x".repeat(remaining);
	expect(escapedCommandBytes(driver, nativeMessagingLaunch({ ...config, personaPrompt }).args)).toBe(4000);
	expect(() => nativeMessagingLaunch({ ...config, personaPrompt: `${personaPrompt}x` })).toThrow("4000-byte");
	for (const oversized of ["x".repeat(4001), "'".repeat(1100), "💡".repeat(1100)]) {
		expect(() => nativeMessagingLaunch({ ...config, personaPrompt: oversized })).toThrow("4000-byte");
		expect(() => nativeMessagingLaunch({ ...config, model: oversized })).toThrow("4000-byte");
		expect(() => nativeMessagingLaunch({ ...config, root: `${config.root}/${oversized}` })).toThrow("4000-byte");
	}
	expect(readdirSync(config.root)).toEqual([]);
});

it.each(["claude-code", "codex"] as const)("rejects remaining %s argument control characters before launch", driver => {
	const config = input(driver);
	for (const control of ["\u0000", "\u001b", "\u007f", "\u0085"]) {
		expect(() => nativeMessagingLaunch({ ...config, personaPrompt: `Context${control}` })).toThrow("control characters");
		expect(() => nativeMessagingLaunch({ ...config, model: `model${control}` })).toThrow("control characters");
	}
	expect(readdirSync(config.root)).toEqual([]);
});

it("binds configuration and server identity to the exact planned client", () => {
	const config = input("codex");
	const first = nativeMessagingLaunch(config);
	expect(nativeMessagingLaunch(config)).toEqual(first);
	const successor = nativeMessagingLaunch({ ...config, clientGeneration: "agent_client_successor" });
	expect(successor.serverName).not.toBe(first.serverName);
	expect(successor.descriptorPath).not.toBe(first.descriptorPath);
	expect(successor.configurationHash).not.toBe(first.configurationHash);
	expect(nativeMessagingLaunch({ ...config, personaPrompt: "Different context." }).configurationHash).not.toBe(first.configurationHash);
	expect(nativeMessagingLaunch({ ...config, model: "different-model" }).configurationHash).not.toBe(first.configurationHash);
	expect(() => nativeMessagingLaunch({ ...config, nodeExecutable: "node" })).toThrow("absolute Node executable");
	expect(() => nativeMessagingLaunch({ ...config, root: "runtime" })).toThrow("absolute Runtime root");
});
