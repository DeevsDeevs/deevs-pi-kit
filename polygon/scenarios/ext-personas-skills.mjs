import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, script } from "../drive.mjs";
import { jsonl, requests, runs, settled } from "../look.mjs";

export default {
	name: "ext-personas-skills",
	gate: "M0",
	bodies: true,
	async run(t) {
		const skillDir = join(t.repo, ".pi", "skills", "polygon-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: polygon-skill\ndescription: Polygon fixture skill.\n---\n# Polygon skill\n");
		writeFileSync(join(t.repo, ".pi", "pi-kit.json"), JSON.stringify({ verify: true }));
		const persona = readFileSync(join(t.kit, "extensions/subagents/agents/explorer.md"), "utf8").split("\n---\n")[1];
		const personaLine = persona.split("\n").find((line) => line.trim() && !line.startsWith("#"));
		const marks = { sandboxSkill: "<name>polygon-skill</name>", kitSkill: "<name>diagnose</name>", persona: JSON.stringify(personaLine).slice(1, -1), verify: "Never pip-install into the system Python." };
		t.marks.push(...Object.values(marks));

		const lead = rpc(t);
		// The child's bash keeps its report out of the launching run, so it wakes the idle lead with no prompt.
		const child = { agent: "child", steps: [{ id: "c0", tool: "bash", args: { command: "sleep 1" } }, { id: "c1", text: "child done" }] };
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "persona probe", subagent_type: "Explore", prompt: script(child) } },
			{ id: "s2", text: "launched" },
			// The woken run's second request is built by Pi's next-turn refresh, not by before_agent_start.
			{ id: "s3", tool: "bash", args: { command: "true" } },
			{ id: "s4", text: "woke" },
		] });
		await lead.until((_, events) => runs(events) >= 2 && settled(events) >= 2, 30_000, "the lead to settle after the subagent reports");

		const seen = requests(t);
		assert.deepEqual(seen.filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3", "s4"], "the finished subagent did not wake the idle lead exactly once");
		const leadMarks = new Set(seen.filter((r) => r.agent === "lead").flatMap((r) => r.marks));
		const childMarks = new Set(seen.filter((r) => r.agent === "child").flatMap((r) => r.marks));
		assert.ok(leadMarks.has(marks.sandboxSkill), "the sandbox skill is missing from the lead's system prompt");
		assert.ok(leadMarks.has(marks.kitSkill), "the kit's skills are missing from the lead's system prompt");
		assert.ok(childMarks.has(marks.persona), "the explorer persona body is missing from the subagent's system prompt");
		assert.ok(seen.filter((r) => r.agent === "lead").every((r) => r.marks.includes(marks.verify)) && childMarks.has(marks.verify), "the verification rule is missing from a lead request or the subagent's system prompt");
		const systems = jsonl(join(t.dir, "bodies.jsonl")).filter((b) => b.agent === "lead").map((b) => JSON.stringify(b.body.messages.filter((m) => m.role === "system")));
		assert.equal(new Set(systems).size, 1, "the lead's system messages changed between its requests");
	},
};
