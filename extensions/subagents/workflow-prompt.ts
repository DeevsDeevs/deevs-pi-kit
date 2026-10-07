import { readFileSync } from "node:fs";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isAutonomous } from "../shared/autonomy.ts";

export const WORKFLOW_SNIPPET = "Orchestrate many background agents with a script, once the user has opted in.";

export const WORKFLOW_DESCRIPTION = `Run a JavaScript workflow script that orchestrates many agents. It runs in the background: the call returns a task ID at once, a <task-notification> reports the outcome, and /agents shows live progress.

Call it ONLY after the user has opted into multi-agent orchestration: a workflow can start dozens of agents and spend a great many tokens, so that scale must come from the user, never from your own guess. The user has opted in when:
- a system-reminder says autonomy is on;
- the user asked in their own words for a workflow or multi-agent orchestration ("use a workflow", "fan out agents on this"); a task that would merely gain from one does not count;
- a skill or command the user invoked says to use Workflow;
- the user named a saved workflow to run.

Otherwise do NOT call it, even when parallel work would clearly help: use Agent, or sketch the workflow and its rough cost and ask; mention that saying "use a workflow" next time skips the question.

Before you write a script, load the \`workflow-authoring\` skill (script API, pitfalls, resume, patterns) unless your system prompt already holds it. Send the script inline as \`script\`.`;

export const WORKFLOW_FIELDS = {
	script: "Plain JavaScript: `export const meta = { name, description, phases }` as a pure literal first, then the body using agent(), parallel(), pipeline() and phase().",
	scriptPath: "A script file. Every call saves its script and returns this path: edit the file and pass it here to iterate. Wins over `name` and `script`.",
	name: "A saved workflow: .pi/workflows/<name>.js or ~/.pi/agent/workflows/<name>.js. Leave unset when sending `script`.",
	args: "The script's global `args`; a string that starts with `{` or `[` is parsed as JSON.",
	resumeFromRunId: "Run ID of an earlier run in this session: its unchanged prefix of agent() calls replays from the journal. Stop the run with TaskStop first if it still runs.",
} as const;

const REFERENCE = readFileSync(new URL("../../skills/workflow-authoring/SKILL.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "");

const wrap = (text: string): string => `<system-reminder>\n${text}\n</system-reminder>`;
export const AUTONOMY_REMINDERS = {
	full: wrap("Autonomy is on: the user has opted into orchestration for this session. Run every substantive task through the Workflow tool and aim for the most complete, best-verified answer; speed and token cost come second. The Autonomy section and the quality patterns of the workflow authoring reference say how. Work alone only on conversational or trivial turns."),
	sparse: wrap("Autonomy is still on: run substantive tasks through the Workflow tool; see Autonomy in the workflow authoring reference."),
	off: wrap("Autonomy is off: the Workflow tool's own opt-in rule applies again."),
};
type ReminderKind = keyof typeof AUTONOMY_REMINDERS;
const KINDS: ReminderKind[] = ["full", "sparse", "off"];
const REMINDER = "autonomy-reminder";
const SPARSE_AFTER_PROMPTS = 10;

/**
 * Autonomy is the standing Workflow opt-in. Each user prompt may carry one hidden reminder: full when it turns on,
 * sparse after 10 more prompts, off when it turns off. The authoring reference is a system prompt section for leads
 * off Anthropic, and for every lead under autonomy. Both stay away while the Workflow tool is inactive.
 */
export function promptWorkflow(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!pi.getActiveTools().includes("Workflow")) return;
		const autonomous = await isAutonomous(ctx);
		if (autonomous || ctx.model?.provider !== "anthropic") event.systemPromptOptions.sections.workflow_authoring = REFERENCE;
		const kind = reminderDue(ctx.sessionManager.getBranch(), autonomous);
		if (kind) return { message: { customType: REMINDER, content: AUTONOMY_REMINDERS[kind], display: false, details: kind } };
	});
}

/** A compaction drops earlier reminders from context, so counting restarts there. */
export function reminderDue(branch: SessionEntry[], autonomous: boolean): ReminderKind | undefined {
	let last: ReminderKind | undefined;
	let prompts = 0;
	for (const entry of branch) {
		if (entry.type === "compaction") {
			last = undefined;
			prompts = 0;
		} else if (entry.type === "custom_message" && entry.customType === REMINDER) {
			last = KINDS.find((kind) => kind === entry.details);
			prompts = 0;
		} else if (entry.type === "message" && entry.message.role === "user") prompts++;
	}
	if (!autonomous) return last === "full" || last === "sparse" ? "off" : undefined;
	if (last === undefined || last === "off") return "full";
	return prompts >= SPARSE_AFTER_PROMPTS ? "sparse" : undefined;
}
