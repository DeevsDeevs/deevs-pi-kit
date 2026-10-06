import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rpc, script } from "../drive.mjs";
import { requests, runs, settled } from "../look.mjs";

export default {
	name: "ext-personas-skills",
	gate: "M0",
	async run(t) {
		const skillDir = join(t.repo, ".pi", "skills", "polygon-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: polygon-skill\ndescription: Polygon fixture skill.\n---\n# Polygon skill\n");
		const persona = readFileSync(join(t.kit, "extensions/subagents/agents/explorer.md"), "utf8").split("\n---\n")[1];
		const personaLine = persona.split("\n").find((line) => line.trim() && !line.startsWith("#"));
		const marks = { sandboxSkill: "<name>polygon-skill</name>", kitSkill: "<name>diagnose</name>", persona: JSON.stringify(personaLine).slice(1, -1) };
		t.marks.push(...Object.values(marks));

		const lead = rpc(t);
		// The child's bash keeps its report out of the launching run, so it wakes the idle lead with no prompt.
		const child = { agent: "child", steps: [{ id: "c0", tool: "bash", args: { command: "sleep 1" } }, { id: "c1", text: "child done" }] };
		await lead.script({ agent: "lead", steps: [
			{ id: "s1", tool: "Agent", args: { description: "persona probe", subagent_type: "Explore", prompt: script(child) } },
			{ id: "s2", text: "launched" },
			{ id: "s3", text: "woke" },
		] });
		await lead.until((_, events) => runs(events) >= 2 && settled(events) >= 2, 30_000, "the lead to settle after the subagent reports");

		const seen = requests(t);
		assert.deepEqual(seen.filter((r) => r.agent === "lead").map((r) => r.step), ["s1", "s2", "s3"], "the finished subagent did not wake the idle lead exactly once");
		const leadMarks = new Set(seen.filter((r) => r.agent === "lead").flatMap((r) => r.marks));
		const childMarks = new Set(seen.filter((r) => r.agent === "child").flatMap((r) => r.marks));
		assert.ok(leadMarks.has(marks.sandboxSkill), "the sandbox skill is missing from the lead's system prompt");
		assert.ok(leadMarks.has(marks.kitSkill), "the kit's skills are missing from the lead's system prompt");
		assert.ok(childMarks.has(marks.persona), "the explorer persona body is missing from the subagent's system prompt");
	},
};
