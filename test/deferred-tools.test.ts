import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import chainsExtension from "../extensions/chains/index.ts";
import subagentsExtension from "../extensions/subagents/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(extension: (pi: ExtensionAPI) => void) {
	const handlers: [string, Handler][] = [];
	const deferred: string[] = [];
	let active = ["read", "bash"];
	const noop = () => {};
	// SAFETY: the loaded extensions use only these members at load time and in the handlers fired here.
	extension({
		on: (name: string, handler: Handler) => handlers.push([name, handler]),
		registerTool: (tool: { name: string; defaultActive?: boolean }) => { if (tool.defaultActive === false) deferred.push(tool.name); },
		registerCommand: noop, registerEntryRenderer: noop, registerFlag: noop, registerMessageRenderer: noop, registerShortcut: noop,
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => { active = tools; },
	} as unknown as ExtensionAPI);
	const fire = (name: string, event: unknown) => {
		for (const [on, handler] of handlers) if (on === name) handler(event, { cwd: "/" });
	};
	// Releases claimSurface for the next load in this process.
	fire("session_shutdown", {});
	return { deferred, fire, active: () => active };
}

const skillFile = (skill: string) => fileURLToPath(new URL(`../skills/${skill}/SKILL.md`, import.meta.url));

const FAMILIES = [
	{ extension: subagentsExtension, tools: ["job_start", "Monitor"], skills: ["background-tasks", "diagnose", "validation-review", "datadog-pup"] },
	{ extension: chainsExtension, tools: ["chain"], skills: ["chain-system", "wiki", "grill-me"] },
];

it.each(FAMILIES)("registers $tools inactive and loads them when any of $skills is read", ({ extension, tools, skills }) => {
	expect(load(extension).deferred).toEqual(tools);
	for (const skill of skills) {
		const pi = load(extension);
		pi.fire("tool_call", { toolName: "read", input: { path: skillFile(skill) } });
		expect(pi.active()).toEqual(["read", "bash", ...tools]);
	}
});
