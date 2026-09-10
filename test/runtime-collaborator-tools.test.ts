import { expect, it } from "vitest";
import runtimeExtension from "../extensions/runtime/index.ts";

it("exposes the six shared MCP tools once alongside distinct lifecycle and task tools", () => {
	const tools: string[] = [];
	runtimeExtension({
		registerEntryRenderer() {},
		registerCommand() {},
		registerShortcut() {},
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		on() {},
	} as never);
	expect(tools).toEqual(["safe_diff", "collaborator_peers", "collaborator_send", "collaborator_status", "collaborator_receive", "collaborator_received", "collaborator_reply", "collaborator_list", "collaborator_manage", "collaborator_workspace", "collaborator_task"]);
	expect(new Set(tools).size).toBe(tools.length);
});
