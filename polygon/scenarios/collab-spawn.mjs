import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, exec, herdr, rpc, sleep } from "../drive.mjs";
import { notifications, requests, toolCalls } from "../look.mjs";

// A Claude writer and a Codex reviewer start in their own collaborator tabs with no prompt left for a human.
export default {
	name: "collab-spawn",
	gate: "M6",
	live: true,
	timeoutMs: 240_000,
	async run(t) {
		const { cli } = await herdr(t);
		writeFileSync(join(t.repo, "CLAUDE.md"), "fixture instructions\n");
		t.git("add", "."); t.git("commit", "-qm", "claude instructions");
		// The user's own state: the repo is trusted and Claude is set up; the kit seeds everything else.
		const claudeConfig = join(t.home, ".claude", ".claude.json");
		writeFileSync(claudeConfig, JSON.stringify({ hasCompletedOnboarding: true, projects: { [t.repo]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["polygon"], rejected: [] } }));
		const lead = rpc(t);
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "collaborator_manage", args: { action: "start", participants: [
				{ participantId: "writer", model: "claude:opus", profile: "workspace-write" },
				{ participantId: "reviewer", model: "codex:puppet", profile: "read-only" },
			] } },
			{ id: "s2", text: "started" },
		] });
		await lead.until((e) => e.type === "agent_settled", 180_000, "both starts");
		const [start] = toolCalls(lead.events);
		writeFileSync(join(t.dir, "start.json"), JSON.stringify(start, null, 2));
		assert.equal(start.isError, false, start.text);
		assert.deepEqual(start.details.results.map((r) => r.status), ["started", "started"], start.text);
		const labels = (await cli("tab", "list")).tabs.map((tab) => tab.label);
		for (const name of ["writer", "reviewer"]) assert.ok(labels.includes(`collaborator:${name}`), `no collaborator:${name} tab in ${labels}`);
		await eventually(() => requests(t).some((r) => r.wire === "responses"), 30_000, "the reviewer's first request");
		const reviewer = requests(t).find((r) => r.wire === "responses");
		assert.ok(!reviewer.tools.some((name) => name === "apply_patch"), `the reviewer was offered a patch tool: ${reviewer.tools}`);
		const listed = (await cli("agent", "list")).agents;
		writeFileSync(join(t.dir, "agents.json"), JSON.stringify(listed, null, 2));
		const writer = listed.find((agent) => agent.cwd !== t.repo && agent.agent === "claude");
		assert.ok(writer, "no Claude agent outside the main checkout");
		const seeded = JSON.parse(readFileSync(claudeConfig, "utf8"));
		assert.equal(seeded.projects[writer.cwd]?.hasTrustDialogAccepted, true, "the writer's worktree did not inherit Claude trust");
		await sleep(5_000);
		for (const pane of start.details.results.map((r) => r.paneId)) writeFileSync(join(t.dir, `pane-${pane.replace(":", "-")}.txt`), (await exec(t, "herdr", ["pane", "read", pane, "--source", "visible"])).stdout);
		const agents = (await cli("agent", "list")).agents;
		assert.ok(agents.every((agent) => agent.agent_status !== "blocked"), `a tab is blocked: ${JSON.stringify(agents.map((a) => [a.name, a.agent_status]))}`);
		assert.equal(notifications(lead.events).filter((n) => n.customType === "deevs.hosted-runtime.notice.v1").length, 0, "a blocked-tab notice reached the lead");
	},
};
