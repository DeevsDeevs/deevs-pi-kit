import assert from "node:assert/strict";
import { eventually, fixtureModels, herdr, rpc, script } from "../drive.mjs";
import { notifications, requests, toolCalls } from "../look.mjs";

// The user types into a writer's tab; the writer tells main with SendMessage (decision 28).
export default {
	name: "collab-user-types",
	gate: "M6",
	live: true,
	timeoutMs: 180_000,
	async run(t) {
		const { cli } = await herdr(t);
		fixtureModels(t, "polygon", ["writer"]);
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_start", args: { participants: [{ name: "writer", model: "polygon/writer", profile: "workspace-write" }] } },
			{ id: "s2", text: "started" },
		] });
		await lead.until((e) => e.type === "agent_settled", 120_000, "the writer's start");
		const [start] = toolCalls(lead.events);
		assert.equal(start.isError, false, start.text);
		const pane = start.details.results[0].paneId;
		await cli("pane", "wait-output", pane, "--match", "herdr-compat", "--source", "visible", "--timeout", "20000");
		t.marks.push("user-typed-mark");
		await cli("pane", "send-text", pane, script({ agent: "writer", steps: [
			{ id: "w1", tool: "SendMessage", args: { to: "main", message: "the user retargeted me: user-typed-mark" } },
			{ id: "w2", text: "told main" },
		] }));
		await cli("pane", "send-keys", pane, "enter");
		await eventually(() => requests(t).some((r) => r.agent === "writer" && r.marks.includes("user-typed-mark")), 30_000, "the typed mark in the writer's request");
		await eventually(() => notifications(lead.events).some((n) => n.customType === "collaborator-message"), 30_000, "the writer's SendMessage at the lead");
		await eventually(() => requests(t).some((r) => r.agent === "lead" && r.marks.includes("user-typed-mark")), 30_000, "the writer's message in the lead's request");
	},
};
