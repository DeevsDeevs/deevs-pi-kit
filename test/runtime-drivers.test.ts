import { expect, it } from "vitest";
import { findAgent, loadBuiltinAgents } from "../extensions/subagents/agents.ts";
import { resolveCollaboratorCandidate } from "../extensions/runtime/collaborator-policy.ts";
import type { ModelContext } from "../extensions/shared/models.ts";
import { DRIVERS, driverLaunchArgv } from "../extensions/runtime/drivers.ts";
import type { HostedCollaboratorDriver } from "../extensions/runtime/schemas/state.ts";
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

function launchArgv(driver: HostedCollaboratorDriver, input: Parameters<typeof DRIVERS["pi"]["command"]>[0]): string[] {
	return driverLaunchArgv({ driver, agentName: "collab-0123456789abcdef012345678", paneId: "pane_launch", input });
}

it.each(DRIVER_NAMES)("gates the whole %s herdr invocation, not only its driver arguments", (driver) => {
	const argv = launchArgv(driver, representativeInput(driver));
	expect(argv.slice(0, 3)).toEqual(["agent", "start", "collab-0123456789abcdef012345678"]);
	expect(argv.slice(3)).toContain(DRIVERS[driver].kind);
	expect(argv[argv.indexOf("--pane") + 1]).toBe("pane_launch");
	for (const argument of argv) expect(argument).not.toMatch(/\p{Cc}/u);
	const command = ["herdr", ...argv].map(argument => `'${argument.replaceAll("'", `'"'"'`)}'`).join(" ");
	expect(Buffer.byteLength(command)).toBeLessThan(4000);
});

it.each(DRIVER_NAMES)("rejects an oversized or control-character %s launch before the agent starts", (driver) => {
	const input = representativeInput(driver);
	expect(() => launchArgv(driver, { ...input, model: "model\u001b" })).toThrow("control characters");
	expect(() => launchArgv(driver, { ...input, model: "x".repeat(4001) })).toThrow("4000-byte");
});

// 3950 escaped bytes of driver argv alone, which only exceeds the limit once the herdr agent start prefix is counted.
it("counts the herdr prefix against the escaped command limit", () => {
	const input = { ...representativeInput("pi"), model: `openai-codex/${"m".repeat(3700)}` };
	expect(() => launchArgv("pi", input)).toThrow("4000-byte");
});

/** A persona body is real markdown: every native launch must still reach Herdr free of control characters. */
it.each(["claude-code", "codex"] as const)("collapses a multi-line built-in persona into the %s launch argv", (driver) => {
	const definition = findAgent(loadBuiltinAgents(), "reviewer");
	const prompt = definition?.body.trim() ?? "";
	expect(prompt).toMatch(/\n/);
	const registry = { getAll: () => [{ provider: "anthropic", id: "claude-opus-5-5" }], getAvailable: () => [], find: () => undefined };
	const models = { config: { models: {}, lead: null }, registry, codex: { slugs: ["gpt-6-astra"] } } as unknown as ModelContext;
	const candidate = resolveCollaboratorCandidate({ participantId: "child", model: driver === "codex" ? "codex:gpt-6-astra" : "claude:opus", persona: "reviewer" }, models);
	expect(candidate.driver).toBe(driver);
	expect(candidate.profile).toBe("read-only");
	const input = { profile: candidate.profile, cwd: "/project", persona: candidate.persona };
	const argv = launchArgv(driver, input);
	for (const argument of argv) expect(argument).not.toMatch(/\p{Cc}/u);
	expect(argv.join(" ")).toContain(prompt.split("\n")[0]);
});

it("resumes a stood-down Claude or Codex collaborator in its own native session", () => {
	const session = "9fb61616-532a-4078-be08-a07d2f707186";
	const claude = launchArgv("claude-code", { ...representativeInput("claude-code"), resume: session });
	expect(claude.slice(claude.indexOf("--") + 1, claude.indexOf("--") + 3)).toEqual(["--resume", session]);
	const codex = launchArgv("codex", { ...representativeInput("codex"), resume: session });
	const startup = codex.slice(codex.indexOf("--") + 1);
	expect(startup[0]).toBe("resume");
	expect(startup.slice(startup.lastIndexOf("--") + 1, startup.lastIndexOf("--") + 2)).toEqual([session]);
	expect(launchArgv("codex", representativeInput("codex"))).not.toContain("resume");
});
