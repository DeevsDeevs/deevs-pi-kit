import { homedir } from "node:os";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activateWithSkill } from "../extensions/shared/surface.ts";

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let active = ["read"];
	let changes = 0;
	// SAFETY: activateWithSkill uses only these members.
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => { active = tools; changes++; },
	} as unknown as ExtensionAPI;
	return { pi, handlers, active: () => active, changes: () => changes };
}

const branch = (entries: unknown[]) => ({ cwd: "/", sessionManager: { getBranch: () => entries } }) as unknown as ExtensionContext;
const skillFile = (skill: string) => fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url));

it("brings a skill's tool back on a branch that already used it or read the skill", () => {
	const used = fakePi();
	activateWithSkill(used.pi, ["wiki"], ["wiki"]);
	used.handlers.get("session_start")!({}, branch([]));
	expect(used.active()).toEqual(["read"]);
	used.handlers.get("session_tree")!({}, branch([{ type: "message", message: { role: "toolResult", toolName: "wiki" } }]));
	expect(used.active()).toEqual(["read", "wiki"]);

	const read = fakePi();
	activateWithSkill(read.pi, ["wiki"], ["wiki"]);
	const path = `~/${relative(homedir(), skillFile("wiki"))}`;
	read.handlers.get("session_start")!({}, branch([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path } }] } }]));
	expect(read.active()).toEqual(["read", "wiki"]);
});

it("loads a whole family in one change from any of its skills, read with read, cat or /skill:", () => {
	const tools = ["job_start", "Monitor"];
	const skills = ["background-tasks", "diagnose"];
	const ctx = branch([]);

	const read = fakePi();
	activateWithSkill(read.pi, tools, skills);
	read.handlers.get("tool_call")!({ toolName: "read", input: { path: skillFile("diagnose") } }, ctx);
	read.handlers.get("tool_call")!({ toolName: "read", input: { path: skillFile("background-tasks") } }, ctx);
	expect([read.active(), read.changes()]).toEqual([["read", ...tools], 1]);

	const cat = fakePi();
	activateWithSkill(cat.pi, tools, skills);
	cat.handlers.get("tool_call")!({ toolName: "bash", input: { command: "cat /opt/kit/skills/README.md" } }, ctx);
	expect(cat.active()).toEqual(["read"]);
	cat.handlers.get("tool_call")!({ toolName: "bash", input: { command: "sed -n 1,80p /opt/kit/skills/background-tasks/SKILL.md" } }, ctx);
	expect(cat.active()).toEqual(["read", ...tools]);

	const resumed = fakePi();
	activateWithSkill(resumed.pi, tools, skills);
	resumed.handlers.get("session_start")!({}, branch([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "cat skills/diagnose/SKILL.md" } }] } }]));
	expect(resumed.active()).toEqual(["read", ...tools]);

	const slash = fakePi();
	activateWithSkill(slash.pi, tools, skills);
	slash.handlers.get("input")!({ text: "/skill:diagnose-more why" }, ctx);
	expect(slash.active()).toEqual(["read"]);
	slash.handlers.get("input")!({ text: " /skill:diagnose why" }, ctx);
	expect(slash.active()).toEqual(["read", ...tools]);
});
