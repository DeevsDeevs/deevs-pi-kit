import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { driverLaunchArgv } from "../extensions/runtime/drivers.ts";
import type { HostedNativeCollaboratorDriver } from "../extensions/runtime/schemas/state.ts";
import { nativeMessagingConfiguration } from "../extensions/runtime/mcp/native.ts";
import { toolDefinitions } from "../extensions/runtime/mcp/tools.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function input(driver: HostedNativeCollaboratorDriver) {
	const root = mkdtempSync(join(tmpdir(), "native-messaging-config-"));
	roots.push(root);
	return { driver, root, targetKey: "target_native", nodeExecutable: process.execPath, model: "configured-model", personaPrompt: "Selected persona context." };
}

type NativeInput = ReturnType<typeof input>;

function launch(config: NativeInput): { argv: string[]; args: string[]; descriptorPath: string; serverName: string } {
	const mcp = nativeMessagingConfiguration(config);
	const input = { profile: "workspace-write" as const, cwd: config.root, model: config.model, mcp };
	const argv = driverLaunchArgv({ driver: config.driver, agentName: "collab-native", paneId: "pane_native", input });
	return { argv, args: argv.slice(argv.indexOf("--") + 1), descriptorPath: mcp.descriptorPath, serverName: mcp.serverName };
}

function escapedCommandBytes(argv: string[]): number {
	return Buffer.byteLength(["herdr", ...argv].map(argument => `'${argument.replaceAll("'", `'"'"'`)}'`).join(" "));
}

it.each(["claude-code", "codex"] as const)("compiles %s native configuration without processes, credentials or permission overrides", driver => {
	const config = { ...input(driver), personaPrompt: "Selected persona\r\n\tcontext." };
	const compiled = launch(config);
	for (const arg of compiled.args) expect(arg).not.toMatch(/\p{Cc}/u);
	expect(readdirSync(config.root)).toEqual([]);
	expect(compiled.descriptorPath.startsWith(`${config.root}/messaging-`)).toBe(true);
	expect(compiled.serverName).toMatch(/^pi_kit_[a-f0-9]{24}$/);
	for (const tool of toolDefinitions) expect(`mcp__${compiled.serverName}__${tool.name}`.length).toBeLessThanOrEqual(64);
	for (const flag of ["--safe-mode", "--restricted", "--tools", "--allowedTools", "--permission-mode", "--strict-mcp-config", "--ask-for-approval", "--disable", "--dangerously-bypass-permissions", "--dangerously-bypass-approvals-and-sandbox"]) expect(compiled.args).not.toContain(flag);
	expect(compiled.args[compiled.args.indexOf("--model") + 1]).toBe(config.model);
	expect(compiled.args.join("\n")).not.toContain("developer_instructions=");
	expect(compiled.args.join("\n")).not.toContain("trust_level");
	const context = driver === "claude-code" ? compiled.args[compiled.args.indexOf("--append-system-prompt") + 1]! : compiled.args.at(-1)!;
	expect(context).toContain("Selected persona context.");
	expect(context).toContain("call collaborator_inbox, do what it asks, answer with collaborator_reply");
	expect(context.length).toBeLessThan(400);
	expect(escapedCommandBytes(compiled.argv)).toBeLessThanOrEqual(4000);
	expect(launch({ ...config, personaPrompt: "Selected persona context." }).args).toEqual(compiled.args);
	if (driver === "claude-code") {
		const servers = JSON.parse(compiled.args[compiled.args.indexOf("--mcp-config") + 1]!).mcpServers;
		expect(Object.keys(servers)).toEqual([compiled.serverName]);
		expect(servers[compiled.serverName]).toEqual({ command: realpathSync(process.execPath), args: [resolve("extensions/runtime/mcp/main.mjs"), compiled.descriptorPath] });
	} else {
		expect(compiled.args.slice(0, 2)).toEqual(["--sandbox", "workspace-write"]);
		expect(compiled.args[compiled.args.indexOf("--config") + 1]).toBe(`mcp_servers.${compiled.serverName}={command=${JSON.stringify(realpathSync(process.execPath))},args=${JSON.stringify([resolve("extensions/runtime/mcp/main.mjs"), compiled.descriptorPath])}}`);
		expect(compiled.args.at(-2)).toBe("--");
	}
});

it.each(["claude-code", "codex"] as const)("bounds the escaped %s launch command before authority or process creation", driver => {
	const config = input(driver);
	const initial = launch(config);
	const remaining = 4000 - escapedCommandBytes(initial.argv);
	expect(remaining).toBeGreaterThan(0);
	const personaPrompt = config.personaPrompt + "x".repeat(remaining);
	expect(escapedCommandBytes(launch({ ...config, personaPrompt }).argv)).toBe(4000);
	expect(() => launch({ ...config, personaPrompt: `${personaPrompt}x` })).toThrow("4000-byte");
	for (const oversized of ["x".repeat(4001), "'".repeat(1100), "💡".repeat(1100)]) {
		expect(() => launch({ ...config, personaPrompt: oversized })).toThrow("4000-byte");
		expect(() => launch({ ...config, model: oversized })).toThrow("4000-byte");
		expect(() => launch({ ...config, root: `${config.root}/${oversized}` })).toThrow("4000-byte");
	}
	expect(readdirSync(config.root)).toEqual([]);
});

it.each(["claude-code", "codex"] as const)("rejects remaining %s argument control characters before launch", driver => {
	const config = input(driver);
	for (const control of ["\u0000", "\u001b", "\u007f", "\u0085"]) {
		expect(() => launch({ ...config, personaPrompt: `Context${control}` })).toThrow("control characters");
		expect(() => launch({ ...config, model: `model${control}` })).toThrow("control characters");
	}
	expect(readdirSync(config.root)).toEqual([]);
});

it("binds the messaging server identity to the exact planned target", () => {
	const config = input("codex");
	const first = launch(config);
	expect(launch(config)).toEqual(first);
	const successor = launch({ ...config, targetKey: "target_successor" });
	expect(successor.serverName).not.toBe(first.serverName);
	expect(successor.descriptorPath).not.toBe(first.descriptorPath);
	expect(launch({ ...config, personaPrompt: "Different context." }).args).not.toEqual(first.args);
	expect(launch({ ...config, model: "different-model" }).args).not.toEqual(first.args);
	expect(() => nativeMessagingConfiguration({ ...config, nodeExecutable: "node" })).toThrow("absolute Node executable");
	expect(() => nativeMessagingConfiguration({ ...config, root: "runtime" })).toThrow("absolute Runtime root");
});
