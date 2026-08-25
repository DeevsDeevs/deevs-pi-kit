import { expect, it } from "vitest";
import runtimeExtension from "../extensions/runtime/index.ts";

it("exposes one collaborator tool per concern", () => {
	const tools: string[] = [];
	runtimeExtension({
		registerEntryRenderer() {},
		registerCommand() {},
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		on() {},
	} as never);
	expect(tools).toEqual(["collaborator_list", "collaborator_manage", "collaborator_send"]);
});
