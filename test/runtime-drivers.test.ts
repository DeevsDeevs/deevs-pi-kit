import { expect, it } from "vitest";
import { DRIVERS, driverLaunchArgv } from "../extensions/runtime/drivers.ts";
import type { HostedCollaboratorDriver } from "../extensions/runtime/hosted-types.ts";
import { nativeMessagingConfiguration } from "../extensions/runtime/mcp/native.ts";

const DRIVER_NAMES: HostedCollaboratorDriver[] = ["pi", "claude-code", "codex"];
const PERSONA = { name: "reviewer", prompt: "Review the diff and report findings.", promptHash: "b".repeat(64) };

function representativeInput(driver: HostedCollaboratorDriver) {
	const base = {
		profile: "workspace-write" as const,
		cwd: "/project",
		sessionFile: "/project/.runtime/collaborator-sessions/launch.jsonl",
		model: "openai-codex/gpt-5.6-sol",
		persona: PERSONA,
	};
	if (!DRIVERS[driver].bind) return base;
	const mcp = nativeMessagingConfiguration({
		root: "/runtime",
		targetKey: "agent_target",
		nodeExecutable: process.execPath,
		personaPrompt: PERSONA.prompt,
	});
	return { ...base, mcp };
}

it("keeps one launch table entry per collaborator driver", () => {
	expect(Object.keys(DRIVERS).sort()).toEqual([...DRIVER_NAMES].sort());
});

it.each(DRIVER_NAMES)("bounds the %s launch argv and keeps it free of control characters", (driver) => {
	const argv = driverLaunchArgv(driver, representativeInput(driver));
	expect(argv.length).toBeGreaterThan(0);
	for (const argument of argv) expect(argument).not.toMatch(/\p{Cc}/u);
	const command = [DRIVERS[driver].kind, ...argv].map(argument => `'${argument.replaceAll("'", `'"'"'`)}'`).join(" ");
	expect(Buffer.byteLength(command)).toBeLessThan(4000);
});

it.each(DRIVER_NAMES)("rejects an oversized or control-character %s launch before the agent starts", (driver) => {
	const input = representativeInput(driver);
	expect(() => driverLaunchArgv(driver, { ...input, model: "model\u001b" })).toThrow("control characters");
	expect(() => driverLaunchArgv(driver, { ...input, model: "x".repeat(4001) })).toThrow("4000-byte");
});
