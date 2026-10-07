import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUserExtension from "../extensions/ask-user/index.ts";
import chainsExtension from "../extensions/chains/index.ts";
import missionExtension from "../extensions/mission/index.ts";
import runtimeExtension from "../extensions/runtime/index.ts";
import subagentsExtension from "../extensions/subagents/index.ts";
import todosExtension from "../extensions/todos/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(extension: (pi: ExtensionAPI) => void) {
	const handlers: [string, Handler][] = [];
	const registered: string[] = [];
	const deferred: string[] = [];
	let active = ["read", "bash"];
	const noop = () => {};
	// SAFETY: the loaded extensions use only these members at load time and in the handlers fired here.
	extension({
		on: (name: string, handler: Handler) => handlers.push([name, handler]),
		registerTool: (tool: { name: string; defaultActive?: boolean }) => { (tool.defaultActive === false ? deferred : registered).push(tool.name); },
		registerCommand: noop, registerEntryRenderer: noop, registerFlag: noop, registerMessageRenderer: noop, registerShortcut: noop,
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => { active = tools; },
	} as unknown as ExtensionAPI);
	const fire = (name: string, event: unknown) => {
		for (const [on, handler] of handlers) if (on === name) handler(event, { cwd: "/" });
	};
	// Releases claimSurface for the next load in this process.
	fire("session_shutdown", {});
	return { registered, deferred, fire, active: () => active };
}

const skillFile = (skill: string) => fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url));

const FAMILIES = [
	{ extension: subagentsExtension, tools: ["job_start", "Monitor"], skills: ["background-tasks", "diagnose", "validation-review", "datadog-pup"] },
	{ extension: askUserExtension, tools: ["ask_user"], skills: ["ask-user"] },
	{ extension: todosExtension, tools: ["todo_list"], skills: ["todos"] },
	{ extension: runtimeExtension, tools: ["collaborator_start", "collaborator_workspace"], skills: ["collaborators"] },
	{ extension: missionExtension, tools: ["mission_start", "mission_update", "mission_get"], skills: ["missions"] },
];

it.each(FAMILIES)("registers $tools inactive and loads them when any of $skills is read", ({ extension, tools, skills }) => {
	expect(load(extension).deferred).toEqual(tools);
	for (const skill of skills) {
		const pi = load(extension);
		pi.fire("tool_call", { toolName: "read", input: { path: skillFile(skill) } });
		expect(pi.active()).toEqual(["read", "bash", ...tools]);
	}
});

it("keeps chain on from the first request, and no skill read or 80% reminder changes the tool list for it", () => {
	const chains = load(chainsExtension);
	expect([chains.registered, chains.deferred]).toEqual([["chain"], []]);
	chains.fire("tool_call", { toolName: "read", input: { path: skillFile("chain-system") } });
	expect(chains.active()).toEqual(["read", "bash"]);
});

it("keeps the autonomy rule on every lead request once ask_user is deferred", () => {
	const guidelines: string[] = [];
	const noop = () => {};
	// SAFETY: registration reads only these members.
	subagentsExtension({ on: noop, registerCommand: noop, registerTool: (tool: { name: string; promptGuidelines?: string[] }) => { if (tool.name === "Agent") guidelines.push(...tool.promptGuidelines ?? []); } } as unknown as ExtensionAPI);
	expect(guidelines).toContain("Anything short of irreversible or destructive: state the default you assume and continue.");
});
