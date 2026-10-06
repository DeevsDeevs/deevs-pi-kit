import { readFileSync } from "node:fs";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isAutonomous } from "../shared/autonomy.ts";

export const WORKFLOW_SNIPPET = "Run a JavaScript workflow that orchestrates many agents in the background, once the user has opted in.";

export const WORKFLOW_DESCRIPTION = `Run a workflow script that orchestrates many agents with deterministic JavaScript. The run goes to the background: this tool returns a task ID at once, and a <task-notification> reports the outcome when the run ends. /agents shows live progress.

Call this tool ONLY after the user has opted into multi-agent orchestration. A workflow can start dozens of agents and spend a great many tokens, so that scale has to come from the user, never from your own guess. The user has opted in when:
- autonomy is on (a system-reminder says so); see **Autonomy** in the workflow authoring reference;
- the user asked, in their own words, for a workflow or for multi-agent orchestration ("use a workflow", "fan out agents on this", "orchestrate it with subagents"). A task that would merely gain from one does not count;
- a skill or command the user invoked says to use Workflow;
- the user named a particular saved workflow to run.

Otherwise do NOT call it, even when parallel work would clearly help. Use the Agent tool for single agents, or sketch what a workflow would do and roughly what it would cost and ask whether to run it; mention that saying "use a workflow" next time skips the question.

Every script starts with \`export const meta = {...}\`, a plain literal (constants only: no variables, function calls or \${}) giving \`name\`, a single-line \`description\` that the workflow widget displays, and optional \`phases\`: \`{ title, detail? }\` for each phase() call, titles identical. Send the script inline as \`script\`, with no need to save it to a file beforehand, and leave the tool's \`name\` unset (that runs a saved workflow). Scripts are JavaScript; TypeScript syntax does not parse.

The usual multi-stage shape is a pipeline, so each item moves on as soon as its own stage finishes:
  export const meta = {
    name: 'audit-routes',
    description: 'Audit each API route, then try to disprove every issue found',
    phases: [{ title: 'Audit' }, { title: 'Check' }],
  }
  const ROUTES = [{ id: 'auth', prompt: '...' }, { id: 'billing', prompt: '...' }]
  const checked = await pipeline(
    ROUTES,
    r => agent(r.prompt, { label: \`audit:\${r.id}\`, phase: 'Audit', schema: ISSUES }),
    audit => parallel(audit.issues.map(i => () =>
      agent(\`Try to disprove: \${i.title}\`, { label: \`check:\${i.file}\`, phase: 'Check', schema: VERDICT })
        .then(v => ({ ...i, verdict: v }))
    ))
  )
  return { real: checked.flat().filter(Boolean).filter(i => i.verdict?.holds) }
  // The auth issues are being checked while billing is still under audit.

Load the \`workflow-authoring\` skill (the script API and its pitfalls, resume, quality patterns, examples) before you write a script, unless your system prompt already holds it.`;

export const WORKFLOW_FIELDS = {
	script: "The workflow script, self-contained: `export const meta = { name, description, phases }` (a plain literal) first, then the body using agent(), parallel(), pipeline() and phase().",
	scriptPath: "Path of a workflow script on disk. Every call saves its script and returns the path; edit that file and pass it here to iterate without resending the script. Wins over `name` and `script`.",
	name: "A saved workflow, from .pi/workflows/<name>.js or ~/.pi/agent/workflows/<name>.js.",
	args: "A value the script reads as the global `args`, unchanged. Give arrays and objects as JSON values: a JSON-encoded string arrives as one string and `args.map` fails.",
	resumeFromRunId: "The Run ID of an earlier run in this session. The longest unchanged prefix of agent() calls replays from its journal; changed and new calls run live. Stop that run first with TaskStop if it is still running.",
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
