import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isAutonomous } from "../shared/config.ts";
import { systemReminder } from "../shared/tasks.ts";
import { DELIVERABLE_FIRST } from "./definitions.ts";

export const WORKFLOW_SNIPPET = "Orchestrate many background agents with a script, once the user has opted in.";

export const WORKFLOW_DESCRIPTION = `Run a JavaScript workflow script that orchestrates many agents. It runs in the background: the call returns a task ID at once, a <task-notification> reports the outcome, and /agents shows live progress. Until it arrives you know nothing of the result: do not poll, sleep, watch its files or guess it; keep working, or end your turn and the notification starts your next one.

Call it ONLY after the user has opted into multi-agent orchestration: a workflow can start dozens of agents and spend a great many tokens, so that scale must come from the user, never from your own guess. The user has opted in when:
- a system-reminder says autonomy is on;
- the user asked in their own words for a workflow or multi-agent orchestration ("use a workflow", "fan out agents on this"); a task that would merely gain from one does not count;
- a skill or command the user invoked says to use Workflow;
- the user named a saved workflow to run.

Otherwise do NOT call it, even when parallel work would clearly help: use Agent, or sketch the workflow and its rough cost and ask; mention that saying "use a workflow" next time skips the question.

Before you write a script, load the \`workflow-authoring\` skill (script API, pitfalls, resume, patterns). Send the script inline as \`script\`.`;

export const WORKFLOW_FIELDS = {
	script: "Plain JavaScript: `export const meta = { name, description, phases }` as a pure literal first, then the body using agent(), parallel(), pipeline() and phase().",
	scriptPath: "A script file. Every call saves its script and returns this path: edit the file and pass it here to iterate. Wins over `name` and `script`.",
	name: "A saved workflow: .pi/workflows/<name>.js in a trusted project, or ~/.pi/agent/workflows/<name>.js. Leave unset when sending `script`.",
	args: "The script's global `args`; a string that starts with `{` or `[` is parsed as JSON.",
	resumeFromRunId: "Run ID of an earlier run in this session: its unchanged prefix of agent() calls replays from the journal. Stop the run with TaskStop first if it still runs.",
} as const;

export const AUTONOMY_REMINDERS = {
	full: systemReminder(`Autonomy is on: the user has opted into orchestration for this session; start agents and workflows without asking. Work directly on single-file or short fixes, and verify them yourself. Orchestrate when the work splits into independent parts taking minutes each (a review across several files, an audit per package), or when the user asks for, or a large multi-file change needs, an independent review: a Workflow for several agents, an Agent for one, never a one-agent workflow. Make the change the deliverable depends on yourself; never end the turn with it unwritten. ${DELIVERABLE_FIRST} Ask reviewers open questions; change passing work only for a finding backed by a stated requirement or a failing check; for a concrete defect, write the check that reproduces it first. Load the workflow-authoring skill before your first script.`),
	sparse: systemReminder("Autonomy is still on: orchestrate work that splits into independent parts taking minutes each, or that needs an independent review; work directly on short fixes. See Autonomy in the workflow-authoring skill."),
	off: systemReminder("Autonomy is off: the Workflow tool's own opt-in rule applies again."),
};
type ReminderKind = keyof typeof AUTONOMY_REMINDERS;
const KINDS: ReminderKind[] = ["full", "sparse", "off"];
const REMINDER = "autonomy-reminder";
const SPARSE_AFTER_PROMPTS = 10;

/**
 * Autonomy is the standing Workflow opt-in. Each user prompt may carry one hidden reminder: full when it turns on,
 * sparse after 10 more prompts, off when it turns off; none while the Workflow tool is inactive. The authoring
 * reference is the workflow-authoring skill, loaded on demand as in Claude Code.
 */
export function promptWorkflow(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!pi.getActiveTools().includes("Workflow")) return;
		const kind = reminderDue(ctx.sessionManager.getBranch(), isAutonomous(ctx));
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
