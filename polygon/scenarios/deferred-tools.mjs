import assert from "node:assert/strict";
import { join } from "node:path";
import { pi, rpc, script } from "../drive.mjs";
import { requests, settled, taskNotifications, toolCalls } from "../look.mjs";
import { DEFERRED_TOOLS } from "../sandbox.mjs";

// chain is on from the first request. Each other kit tool family joins the lead's tool list once a skill that documents
// it is read, keeps it across /reload and resume, an open mission starts a session with its tools, and a --tools
// allowlist (a Pi collaborator's launch) is never widened. Print mode loads and uses a family the same way.
const KIT_TOOLS = ["chain", ...DEFERRED_TOOLS];

export default {
	name: "deferred-tools",
	gate: "M0",
	deferred: true,
	timeoutMs: 180_000,
	async run(t) {
		const skill = (name) => join(t.kit, "skills", name, "SKILL.md");
		const offered = (agent, step) => {
			const request = requests(t).find((r) => r.agent === agent && r.step === step);
			assert.ok(request, `no ${agent} request answered ${step}`);
			return KIT_TOOLS.filter((tool) => request.tools.includes(tool));
		};
		// Settled after the turn that the nth task-notification started, so the next prompt never lands inside a run.
		const quiet = (lead, reports) => lead.until((e, events) => e.type === "agent_settled" && taskNotifications(events.slice(0, events.indexOf(e))).length >= reports, 30_000, `the turn after report ${reports}`);
		const lead = rpc(t, { args: ["-e", "/polygon/fixtures/polygon-reload.ts"] });
		await lead.script({ agent: "lead", steps: [
			{ id: "a1", text: "ready" },
			{ id: "f1", on: "go-families", tool: "read", args: { path: skill("background-tasks") } },
			{ id: "f2", then: true, tool: "job_start", args: { command: "echo deferred-job", description: "probe" } },
			{ id: "f3", then: true, tool: "chain", args: { action: "list" } },
			{ id: "f4", then: true, tool: "bash", args: { command: `cat ${skill("todos")} >/dev/null` } },
			{ id: "f5", then: true, tool: "todo_list", args: { operation: "read" } },
			{ id: "f6", then: true, tool: "read", args: { path: skill("ask-user") } },
			{ id: "f7", then: true, tool: "read", args: { path: skill("collaborators") } },
			{ id: "f8", then: true, tool: "read", args: { path: skill("missions") } },
			{ id: "f9", then: true, tool: "mission_start", args: { title: "deferred", goal: "probe", done: "never" } },
			{ id: "f10", then: true, tool: "mission_update", args: { log: "started", next: "wait", status: "waiting_user" } },
			{ id: "f11", then: true, text: "families" },
			{ id: "r1", on: "go-reload", tool: "Monitor", args: { description: "probe", command: "echo tick", once: true } },
			{ id: "r2", then: true, text: "watching" },
			{ id: "m1", on: "go-resume", text: "resumed" },
		] });
		await lead.until((e) => e.type === "agent_settled", 30_000, "the first turn");
		await lead.prompt("go-families");
		await quiet(lead, 1);

		assert.deepEqual(offered("lead", "a1"), ["chain"], "a fresh session offers chain and no deferred kit tool");
		assert.deepEqual(offered("lead", "f1"), ["chain"]);
		assert.deepEqual(offered("lead", "f2"), ["chain", "job_start", "Monitor"], "reading background-tasks loads its family, and only it");
		assert.deepEqual(offered("lead", "f5"), ["chain", "job_start", "Monitor", "todo_list"], "cat of a skill file loads its family");
		assert.deepEqual(offered("lead", "f7"), ["chain", "job_start", "Monitor", "ask_user", "todo_list"]);
		assert.deepEqual(offered("lead", "f8"), ["chain", "job_start", "Monitor", "ask_user", "todo_list", "collaborator_start", "collaborator_workspace"]);
		assert.deepEqual(offered("lead", "f9"), KIT_TOOLS);

		await lead.prompt("/polygon-reload");
		await lead.prompt("go-reload");
		await quiet(lead, 2);
		assert.deepEqual(offered("lead", "r1"), KIT_TOOLS, "/reload keeps every loaded tool");

		const before = settled(lead.events);
		await lead.restart(["--continue"]);
		await lead.prompt("go-resume");
		await lead.until((_, events) => settled(events) > before, 30_000, "the resumed turn");
		assert.deepEqual(offered("lead", "m1"), KIT_TOOLS, "resume keeps every loaded tool");
		assert.deepEqual(toolCalls(lead.events).map((c) => [c.name, c.isError]).filter(([name]) => KIT_TOOLS.includes(name)),
			[["job_start", false], ["chain", false], ["todo_list", false], ["mission_start", false], ["mission_update", false], ["Monitor", false]]);
		await lead.close();

		// A new session in the project: the open mission brings its tools.
		const fresh = rpc(t);
		await fresh.script({ agent: "fresh", steps: [{ id: "n1", text: "fresh" }] });
		await fresh.until((e) => e.type === "agent_settled", 30_000, "the fresh session's first turn");
		assert.deepEqual(offered("fresh", "n1"), ["chain", "mission_start", "mission_update", "mission_get"], "an open mission starts the session with its tools");
		await fresh.close();

		// Print mode: a skill read with bash loads job_start, and the run waits for the job's report.
		const print = await pi(t, ["-p", "--no-session", "--model", "polygon/puppet", script({ agent: "print", steps: [
			{ id: "p1", tool: "bash", args: { command: `sed -n 1,3p ${skill("diagnose")}` } },
			{ id: "p2", tool: "job_start", args: { command: "sleep 2; echo print-job", description: "probe", timeout: 60_000 } },
			{ id: "p3", text: "launched" },
			{ id: "p4", on: "task-notification", text: "answered job" },
		] })], { timeoutMs: 45_000 });
		assert.equal(print.status, 0, print.stderr);
		assert.match(print.stdout, /answered job/, "print mode did not run the loaded job_start");
		assert.deepEqual(offered("print", "p1"), ["chain", "mission_start", "mission_update", "mission_get"]);
		assert.deepEqual(offered("print", "p2"), ["chain", "job_start", "Monitor", "mission_start", "mission_update", "mission_get"]);

		// A --tools allowlist, as a Pi collaborator launches: a skill read and the open mission add nothing it does not name.
		const allow = await pi(t, ["-p", "--no-session", "--model", "polygon/puppet", "--tools", "read,bash,SendMessage,chain", script({ agent: "allow", steps: [
			{ id: "q1", tool: "read", args: { path: skill("background-tasks") } },
			{ id: "q2", text: "done" },
		] })], { timeoutMs: 45_000 });
		assert.equal(allow.status, 0, allow.stderr);
		assert.deepEqual(offered("allow", "q1"), ["chain"]);
		assert.deepEqual(offered("allow", "q2"), ["chain"], "a skill read widened a --tools allowlist");
	},
};
