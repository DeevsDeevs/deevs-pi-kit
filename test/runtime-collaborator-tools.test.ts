import { expect, it } from "vitest";
import runtimeExtension from "../extensions/runtime/index.ts";

it("exposes one collaborator tool per concern", () => {
	const tools: string[] = [];
	runtimeExtension({
		registerEntryRenderer() {},
		registerCommand() {},
		registerShortcut() {},
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		on() {},
	} as never);
	expect(tools).toEqual(["safe_diff", "collaborator_list", "collaborator_manage", "collaborator_workspace", "collaborator_send", "collaborator_task"]);
});
