import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatCount, progressBar, statusIcon } from "../shared/dashboard.ts";
import { formatDuration } from "../shared/runtime-ui.ts";
import type { WorkflowDetails } from "./index.ts";

const MAX_FLEET_ROWS = 6;

export class WorkflowWidget implements Component {
	constructor(private readonly details: WorkflowDetails, private readonly theme: Theme) {}
	render(width: number): string[] { return renderWorkflowWidget(this.details, this.theme, width); }
	invalidate(): void {}
}

export class WorkflowFleetWidget implements Component {
	constructor(private readonly workflows: readonly WorkflowDetails[], private readonly theme: Theme) {}
	render(width: number): string[] { return renderWorkflowFleet(this.workflows, this.theme, width); }
	invalidate(): void {}
}

export function renderWorkflowFleet(workflows: readonly WorkflowDetails[], theme: Theme, width = 80): string[] {
	if (workflows.length === 1) return renderWorkflowWidget(workflows[0]!, theme, width);
	const safeWidth = Math.max(1, width);
	const rows = [...workflows].reverse();
	const runningAgents = workflows.reduce((sum, workflow) => sum + workflow.activeAgents, 0);
	const issues = workflows.reduce((sum, workflow) => sum + workflow.agents.filter((agent) => !["queued", "running", "completed"].includes(agent.status)).length, 0);
	const lines = [`${theme.fg("accent", "◆ Workflows")} ${workflows.length} active · ${runningAgents} agents${issues ? ` · ${issues} issues` : ""}`];
	for (const workflow of rows.slice(0, MAX_FLEET_ROWS)) {
		const total = workflow.agents.length;
		const settled = workflow.agents.filter((agent) => !["queued", "running"].includes(agent.status)).length;
		const workflowIssues = workflow.agents.filter((agent) => !["queued", "running", "completed"].includes(agent.status)).length;
		lines.push(`  ${statusIcon(workflow.status)} ${workflow.id.slice(-8)} ${progressBar(settled, Math.max(1, total), 8)} · ${workflow.activeAgents} running${workflowIssues ? ` · ${workflowIssues} issues` : ""}`);
	}
	if (rows.length > MAX_FLEET_ROWS) lines.push(`  … ${rows.length - MAX_FLEET_ROWS} more workflows`);
	return lines.map((line) => truncateToWidth(line, safeWidth, "…", true));
}

export function renderWorkflowWidget(details: WorkflowDetails, theme: Theme, width = 80): string[] {
	const safeWidth = Math.max(1, width);
	const total = details.agents.length;
	const settled = details.agents.filter((agent) => !["queued", "running"].includes(agent.status)).length;
	const errors = details.agents.filter((agent) => !["queued", "running", "completed"].includes(agent.status)).length;
	const lines = [
		`${theme.fg("accent", "◆ Workflow")} ${theme.fg("muted", details.id.slice(-8))}  ${progressBar(settled, Math.max(1, total), Math.min(14, Math.max(4, Math.floor(safeWidth / 5))))}  ${details.activeAgents} running${errors ? ` · ${errors} issues` : ""}`,
	];
	for (const agent of details.agents.slice(-8)) {
		const run = details.runs.find((candidate) => candidate.spec.id === agent.id);
		const tokens = run ? run.runtime.usage.inputTokens + run.runtime.usage.outputTokens + run.runtime.usage.cacheWriteTokens : 0;
		lines.push(`  ${statusIcon(agent.status)} ${agent.persona.padEnd(13)} ${agent.status.padEnd(10)} ${formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt)}${tokens ? ` · ${formatCount(tokens)} tok` : ""}`);
	}
	if (total > 8) lines.push(`  … ${total - 8} earlier agents`);
	return lines.map((line) => truncateToWidth(line, safeWidth, "…", true));
}
