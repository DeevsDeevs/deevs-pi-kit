import { expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { interactiveOnly } from "../extensions/shared/surface.ts";

function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let active = ["read"];
	// SAFETY: interactiveOnly uses only these members.
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => { active = tools; },
	} as unknown as ExtensionAPI;
	return { pi, handlers, active: () => active };
}

it("drops tools that need a person in print and json mode only", () => {
	for (const [mode, expected] of [["print", ["read"]], ["json", ["read"]], ["rpc", ["read", "ask_user"]], ["tui", ["read", "ask_user"]]] as const) {
		const lead = fakePi();
		lead.pi.setActiveTools(["read", "ask_user"]);
		interactiveOnly(lead.pi, ["ask_user"]);
		lead.handlers.get("session_start")!({}, { mode } as ExtensionContext);
		expect(lead.active()).toEqual(expected);
	}
});
