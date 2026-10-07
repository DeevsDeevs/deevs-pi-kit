import { homedir } from "node:os";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activateWithSkill, interactiveOnly } from "../extensions/shared/surface.ts";

/** `registered` stands for a --tools allowlist: setActiveTools drops the names it leaves out, as Pi does. */
function fakePi(registered?: string[]) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let active = ["read"];
	let changes = 0;
	// SAFETY: activateWithSkill uses only these members.
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => { active = registered ? tools.filter((tool) => registered.includes(tool)) : tools; changes++; },
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

	const scripted = fakePi();
	activateWithSkill(scripted.pi, ["wiki"], ["wiki"]);
	scripted.handlers.get("session_start")!({}, branch([{ type: "message", message: { role: "toolResult", toolName: "codemode", nestedCalls: { calls: [{ id: "c1/1", name: "read", arguments: { path }, status: "ok" }], complete: true } } }]));
	expect(scripted.active()).toEqual(["read", "wiki"]);
});

it("drops tools that need a person or Herdr's UI in print and json mode only", () => {
	for (const [mode, expected] of [["print", ["read"]], ["json", ["read"]], ["rpc", ["read", "ask_user"]], ["tui", ["read", "ask_user"]]] as const) {
		const lead = fakePi();
		lead.pi.setActiveTools(["read", "ask_user"]);
		interactiveOnly(lead.pi, ["ask_user"]);
		lead.handlers.get("session_start")!({}, { mode } as ExtensionContext);
		expect(lead.active()).toEqual(expected);
	}
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

it("a direct call to an unloaded tool loads its family and says to call again, or that the tool is not available", () => {
	const tools = ["job_start", "Monitor"];
	const ctx = branch([]);
	const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: name === "read" ? { path: skillFile("background-tasks") } : {} });
	const assistant = (...calls: unknown[]) => ({ message: { role: "assistant", content: calls } });
	const failed = (id: string, toolName: string) => ({ message: { role: "toolResult", toolCallId: id, toolName, isError: true, content: [{ type: "text", text: `Tool ${toolName} not found` }] } });
	const text = (result: unknown) => (result as { message: { content: { text: string }[] } } | undefined)?.message.content[0]!.text;

	const lead = fakePi();
	activateWithSkill(lead.pi, tools, ["background-tasks"]);
	const end = lead.handlers.get("message_end")!;
	end(assistant(call("c1", "Monitor")), ctx);
	expect(text(end(failed("c1", "Monitor"), ctx))).toBe("Monitor was not loaded yet; it is loaded now. Call it again.");
	expect(lead.active()).toEqual(["read", ...tools]);
	end(assistant(call("c2", "job_start")), ctx);
	expect(end(failed("c2", "job_start"), ctx), "a loaded tool's own error stays").toBeUndefined();

	const batch = fakePi();
	activateWithSkill(batch.pi, tools, ["background-tasks"]);
	batch.handlers.get("message_end")!(assistant(call("c3", "read"), call("c4", "job_start")), ctx);
	batch.handlers.get("tool_call")!({ toolName: "read", input: call("c3", "read").arguments }, ctx);
	expect(text(batch.handlers.get("message_end")!(failed("c4", "job_start"), ctx)), "the read in the same batch loaded it after Pi looked").toBe("job_start was not loaded yet; it is loaded now. Call it again.");

	const allowlist = fakePi(["read", "bash", "chain"]);
	activateWithSkill(allowlist.pi, tools, ["background-tasks"]);
	allowlist.handlers.get("message_end")!(assistant(call("c5", "job_start")), ctx);
	expect(text(allowlist.handlers.get("message_end")!(failed("c5", "job_start"), ctx))).toBe("job_start is not available in this session.");
	expect(allowlist.active()).toEqual(["read"]);
});
