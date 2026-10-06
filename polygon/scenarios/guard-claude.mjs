import assert from "node:assert/strict";
import { rpc, script } from "../drive.mjs";
import { dialogs, requests, taskNotes } from "../look.mjs";

export const BLOCKED = ["nohup sleep 1 &", "git push --force origin main", "rm -rf ~/x"];
export const ALLOWED = "rm -rf /tmp/polygon-guard-x";
// The first line of each guard error, as it comes back in the worker's next request.
export const REASONS = ["Detached process launch", "Force push to a protected branch", "Recursive rm outside the project"];

/** The worker runs the allowed command, then the three blocked ones; each reason must reach the model, and only after its command. */
export async function guardThroughCli(t, { model, tool, arg }) {
	t.marks.push(...REASONS);
	const steps = [ALLOWED, ...BLOCKED].map((command, i) => ({ id: `g${i}`, tool, args: { [arg]: command } }));
	const lead = rpc(t);
	await lead.script({ agent: "lead", steps: [
		{ id: "s1", tool: "Agent", args: { description: "guarded worker", prompt: script({ agent: "gw", steps: [...steps, { id: "c1", text: "guarded" }] }), model, subagent_type: "Explore" } },
		{ id: "s2", text: "launched" },
	] });
	await lead.until((_, events) => taskNotes(events).length >= 1, 90_000, "the worker's report");
	const seen = requests(t).filter((r) => r.agent === "gw");
	assert.deepEqual(seen.map((r) => r.step), ["g0", "g1", "g2", "g3", "c1"]);
	assert.deepEqual(seen.map((r) => r.marks.length), [0, 0, 1, 2, 3], "a command was not blocked by the guard hook, or the allowed one was");
	assert.deepEqual(seen.at(-1).marks.sort(), [...REASONS].sort());
	assert.equal(dialogs(lead.events), 0);
}

export default {
	name: "guard-claude",
	gate: "M4",
	timeoutMs: 120_000,
	run: (t) => guardThroughCli(t, { model: "opus", tool: "Bash", arg: "command" }),
};
