import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { rpc } from "../drive.mjs";
import { requests, toolCalls } from "../look.mjs";

const writer = (agent, file) => ({ agent, steps: [
	{ id: `${agent}a`, tool: "bash", args: { command: `printf ${agent} > ${file} && git add ${file} && git commit -qm ${agent}` } },
	{ id: `${agent}b`, text: "committed" },
] });
const spawn = (id, description, child) => ({ id, tool: "Agent", args: { description, prompt: `POLYGON ${JSON.stringify(child)}`, isolation: "worktree" } });

export default {
	name: "worktree-two-writers",
	gate: "M2",
	async run(t) {
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			spawn("s1", "first writer", writer("w1", "one.txt")),
			spawn("s2", "second writer", writer("w2", "two.txt")),
			spawn("s3", "idle writer", { agent: "noop", steps: [{ id: "n1", text: "nothing to change" }] }),
			{ id: "s4", text: "launched" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the launching turn to settle");
		assert.deepEqual(toolCalls(lead.events).filter((c) => c.name === "Agent").map((c) => c.isError), [false, false, false]);

		const worktrees = () => t.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
		const agentBranches = () => t.git("branch", "--list", "agent/*", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
		const seen = () => requests(t).map((r) => `${r.agent}:${r.step}`);
		for (let deadline = Date.now() + 60_000; ; await sleep(250)) {
			const done = ["w1:w1b", "w2:w2b", "noop:n1"].every((s) => seen().includes(s));
			if (done && worktrees().length === 3 && agentBranches().length === 2) break;
			if (Date.now() > deadline) assert.fail(`agents never settled into two kept worktrees: ${JSON.stringify({ requests: seen(), worktrees: worktrees(), branches: agentBranches() })}`);
		}

		const kept = agentBranches();
		assert.deepEqual(kept.map((b) => t.git("log", "-1", "--format=%s", b).trim()).sort(), ["w1", "w2"]);
		for (const branch of kept) assert.equal(t.git("rev-list", "--count", `main..${branch}`).trim(), "1", `${branch} has exactly the writer's commit`);
		const outside = `${realpathSync(t.agentDir)}/pi-kit/worktrees/`;
		assert.deepEqual(worktrees().slice(1).map((p) => p.startsWith(outside)), [true, true], "kept worktrees live outside the repo");
		assert.equal(t.git("status", "--porcelain"), "", "the main tree stays clean");
		assert.equal(t.git("rev-list", "--count", "HEAD").trim(), "1", "main has only the fixture commit");
	},
};
