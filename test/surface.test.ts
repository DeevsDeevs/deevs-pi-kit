import { homedir } from "node:os";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activateWithSkill, interactiveOnly } from "../extensions/shared/surface.ts";

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let active = ["read"];
	// SAFETY: activateWithSkill uses only these members.
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => { active = tools; },
	} as unknown as ExtensionAPI;
	return { pi, handlers, active: () => active };
}

const branch = (entries: unknown[]) => ({ cwd: "/", sessionManager: { getBranch: () => entries } }) as unknown as ExtensionContext;
const skillFile = fileURLToPath(new URL("../skills/wiki/SKILL.md", import.meta.url));

it("brings a skill's tool back on a branch that already used it or read the skill", () => {
	const used = fakePi();
	activateWithSkill(used.pi, "wiki", "wiki");
	used.handlers.get("session_start")!({}, branch([]));
	expect(used.active()).toEqual(["read"]);
	used.handlers.get("session_tree")!({}, branch([{ type: "message", message: { role: "toolResult", toolName: "wiki" } }]));
	expect(used.active()).toEqual(["read", "wiki"]);

	const read = fakePi();
	activateWithSkill(read.pi, "wiki", "wiki");
	const path = `~/${relative(homedir(), skillFile)}`;
	read.handlers.get("session_start")!({}, branch([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path } }] } }]));
	expect(read.active()).toEqual(["read", "wiki"]);
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
