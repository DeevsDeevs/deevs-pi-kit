import assert from "node:assert/strict";
import { rpc, script, sleep } from "../drive.mjs";
import { poll, requests, sessionNotes, toolCalls } from "../look.mjs";

const MARK = "polygon-queued-mark";
const SLOTS = 16;

// A message to an agent still waiting for one of the 16 slots steers it right after its prompt: no run before its slot,
// no second reporter, one notification. A kill -9 before a slot frees loses neither the message nor the order: the 16
// resumed runs keep their slots and the queued agent still waits for one.
export default {
	name: "sendmessage-queued",
	gate: "M2",
	timeoutMs: 120_000,
	async run(t) {
		const lead = rpc(t);
		const blocker = (i) => script({ agent: `b${i}`, steps: [{ id: "w", tool: "bash", args: { command: "sleep 6" } }, { id: "d", text: "done" }] });
		const queued = { agent: "queued", steps: [{ id: "q1", text: "first answer" }, { id: "q2", on: MARK, text: "steered" }] };
		await lead.script({ agent: "lead", steps: [
			...Array.from({ length: SLOTS }, (_, i) => ({ id: `s${i}`, tool: "Agent", args: { description: `blocker ${i}`, prompt: blocker(i) } })),
			{ id: "sq", tool: "Agent", args: { description: "queued probe", name: "queued", prompt: script(queued) } },
			{ id: "sm", tool: "SendMessage", args: { to: "queued", message: MARK } },
			{ id: "se", text: "sent" },
		] });
		await lead.until((_, events) => toolCalls(events).some((c) => c.name === "SendMessage"), 60_000, "the SendMessage result");
		const send = toolCalls(lead.events).find((c) => c.name === "SendMessage");
		assert.deepEqual([send.isError, send.details?.outcome], [false, "steered"]);
		assert.equal(requests(t).filter((r) => r.agent === "queued").length, 0, "the queued agent ran before a slot freed");
		const queuedId = toolCalls(lead.events).filter((c) => c.name === "Agent").at(-1).details.agentId;
		await lead.restart();
		await poll(() => new Set(sessionNotes(t).map((n) => n.taskId)).size >= SLOTS + 1, 90_000, "every agent's notification");
		await sleep(2_000);
		assert.equal(sessionNotes(t).filter((n) => n.taskId === queuedId).length, 1, "the queued agent notified more than once");
		const log = requests(t);
		assert.ok(log.findIndex((r) => r.agent === "queued") > log.findIndex((r) => r.step === "d"), "the queued agent ran before a resumed run freed a slot");
		assert.ok(log.some((r) => r.agent === "queued" && r.step === "q2"), "the message never reached the queued agent");
	},
};
