import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rpc } from "../drive.mjs";
import { taskNotifications, toolCalls } from "../look.mjs";

// A page that changes, stays, changes and fails: three events, one per change, with probes `every` apart.
const PAGES = [[200, "first"], [200, "second"], [200, "second"], [200, "third"], [500, "broken"]];

export default {
	name: "monitor-url",
	gate: "M5",
	slow: true,
	timeoutMs: 240_000,
	async run(t) {
		const probes = [];
		const server = createServer((req, res) => {
			const [status, body] = PAGES[Math.min(probes.length, PAGES.length - 1)];
			probes.push(Date.now());
			res.writeHead(status, { "content-type": "text/plain" });
			res.end(body);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.closers.push(() => new Promise((resolve) => server.close(resolve)));
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Monitor", args: { url: `http://127.0.0.1:${server.address().port}/page`, every: 30, description: "fixture page" } },
			{ id: "s2", text: "watching" },
		] });
		const events = () => taskNotifications(lead.events).filter((n) => n.taskId === toolCalls(lead.events)[0]?.details.taskId).map((n) => n.event);
		await lead.until(() => events().length >= 3, 200_000, "three events");
		assert.equal(toolCalls(lead.events)[0].details.baseline, "200, 5 B");
		assert.deepEqual(events(), ["second", "third", "status 200 → 500"]);
		const gaps = probes.slice(1).map((at, i) => at - probes[i]);
		assert.ok(gaps.every((gap) => gap >= 29_000), `probes closer than every: ${gaps.join(", ")} ms`);
	},
};
