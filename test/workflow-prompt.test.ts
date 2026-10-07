import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getEncoding } from "js-tiktoken";
import { DELIVERABLE_FIRST } from "../extensions/subagents/definitions.ts";
import { AUTONOMY_REMINDERS, promptWorkflow, reminderDue } from "../extensions/subagents/workflow-prompt.ts";

type Handler = (event: object, ctx: object) => Promise<{ message?: { content: string; details: string; display: boolean } } | undefined>;

const user = (): SessionEntry => ({ type: "message", message: { role: "user", content: "go", timestamp: 0 } }) as SessionEntry;
const reminder = (details: string): SessionEntry => ({ type: "custom_message", customType: "autonomy-reminder", content: "", display: false, details }) as SessionEntry;
const compaction = (): SessionEntry => ({ type: "compaction" }) as SessionEntry;
const prompts = (n: number) => Array.from({ length: n }, user);

let agentDir: string;
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "workflow-prompt-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

function lead(tools: string[]) {
	let handler: Handler | undefined;
	promptWorkflow({ on: (_name: string, fn: Handler) => { handler = fn; }, getActiveTools: () => tools } as unknown as ExtensionAPI);
	return async (provider: string, branch: SessionEntry[] = []) => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		const result = await handler!(event, { cwd: agentDir, isProjectTrusted: () => false, model: { provider }, sessionManager: { getBranch: () => branch } });
		return { section: event.systemPromptOptions.sections.workflow_authoring, message: result?.message };
	};
}

it("reminds in full when autonomy starts, sparsely after ten more prompts, and once when it stops", () => {
	expect(reminderDue([], true)).toBe("full");
	expect(reminderDue([user(), reminder("full"), ...prompts(9)], true)).toBeUndefined();
	expect(reminderDue([user(), reminder("full"), ...prompts(10)], true)).toBe("sparse");
	expect(reminderDue([reminder("full"), ...prompts(10), reminder("sparse"), user()], true)).toBeUndefined();
	expect(reminderDue([reminder("sparse"), user()], false)).toBe("off");
	expect(reminderDue([reminder("off"), user()], false)).toBeUndefined();
	expect(reminderDue([reminder("off"), user()], true)).toBe("full");
	expect(reminderDue([], false)).toBeUndefined();
	expect(reminderDue([reminder("full"), user(), compaction(), user()], true)).toBe("full");
});

it("reminds only while the Workflow tool is active, and never inlines the authoring reference", async () => {
	expect(await lead(["Agent"])("anthropic")).toEqual({ section: undefined, message: undefined });
	const on = await lead(["Agent", "Workflow"])("openai-codex");
	expect(on.section).toBeUndefined();
	expect(on.message).toEqual({ customType: "autonomy-reminder", content: AUTONOMY_REMINDERS.full, display: false, details: "full" });
	expect(AUTONOMY_REMINDERS.full).toMatch(/^<system-reminder>\n[\s\S]+\n<\/system-reminder>$/);
});

it("says once that autonomy is off", async () => {
	writeFileSync(join(agentDir, "pi-kit.json"), JSON.stringify({ autonomy: false }));
	const prompt = lead(["Workflow"]);
	expect(await prompt("anthropic")).toEqual({ section: undefined, message: undefined });
	expect((await prompt("openai-codex", [reminder("full"), user()])).message?.details).toBe("off");
});

it("keeps the always-on reminder to permission, working directly by default, when to orchestrate and the deliverable, and how to orchestrate once, in the workflow-authoring skill", () => {
	const skill = /\*\*Autonomy\.\*\*.*/.exec(readFileSync(join(import.meta.dirname, "../skills/workflow-authoring/SKILL.md"), "utf8"))![0];
	const { full, sparse } = AUTONOMY_REMINDERS;
	const when = /[Ww]ork directly and verify it yourself by default; orchestrate only independent parts taking minutes each, a review a large multi-file change needs \(an Agent for one\), or what the user asks for\./;
	expect(full).toMatch(/start agents and workflows without asking\./);
	for (const text of [full, sparse]) expect(text).toMatch(when);
	for (const text of [full, sparse]) expect(text).not.toMatch(/one-agent workflow|single-file|Load the workflow-authoring|side parts/);
	expect(full).not.toContain(DELIVERABLE_FIRST);
	expect(getEncoding("o200k_base").encode(full).length).toBeLessThanOrEqual(150);
	expect(skill).not.toMatch(/token cost|substantive task|an answer|verification/);
	expect(skill).toMatch(/work directly by default\. Orchestrate when the work splits into independent parts taking minutes each.*, or when the user asks for, or a large multi-file change needs, an independent review: a Workflow for several agents, an Agent for one, never a one-agent workflow\./);
	expect(skill).toMatch(/Keep the change the deliverable depends on yourself and make it work first, committed when it is a commit/);
	expect(full).toMatch(/Make the change the deliverable depends on yourself; never end the turn with it unwritten\./);
	const review = readFileSync(join(import.meta.dirname, "../skills/validation-review/SKILL.md"), "utf8");
	for (const text of [full, review]) expect(text).toMatch(/[Aa]sk (each reviewer an open question|reviewers open questions)[\s\S]*hange (work that already passes|passing work) only for a finding backed by a stated requirement or a failing check; for a concrete defect[\s\S]*write the check that reproduces it first/);
});
