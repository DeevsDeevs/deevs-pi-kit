import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { dashboardFrame, detailLines, formatCount, pageWindow, progressBar, selectedRow, statusIcon, tabs } from "../shared/dashboard.ts";
import { formatDuration } from "../shared/runtime-ui.ts";
import { loadBuiltinAgents } from "./agents.ts";
import type { AgentDefinition } from "./catalog-types.ts";
import type { DelegateRun } from "./runtime-types.ts";
import type { SubagentGroup, SubagentService } from "./service.ts";

type AgentRow = { kind: "run"; value: DelegateRun } | { kind: "group"; value: SubagentGroup } | { kind: "persona"; value: AgentDefinition };

export class AgentsDashboard implements Component {
	private tab = 0;
	private selected = 0;

	constructor(
		private readonly service: SubagentService,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly getHeight: () => number,
		private readonly cancel: (id: string) => void,
		private readonly clear: (id: string) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return this.done();
		if (matchesKey(data, Key.left) || matchesKey(data, "h")) { this.tab = (this.tab + 2) % 3; this.selected = 0; }
		if (matchesKey(data, Key.right) || matchesKey(data, "l") || matchesKey(data, Key.tab)) { this.tab = (this.tab + 1) % 3; this.selected = 0; }
		const rows = this.rows();
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
		const row = rows[this.selected];
		if (matchesKey(data, "x") && row && row.kind !== "persona" && isActive(row.value)) this.cancel(row.kind === "group" ? row.value.id : row.value.spec.id);
		if (matchesKey(data, "c") && row && row.kind !== "persona" && !isActive(row.value)) this.clear(row.kind === "group" ? row.value.id : row.value.spec.id);
		this.requestRender();
	}

	render(width: number): string[] {
		const state = this.service.list();
		const runs = [...state.runs].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.runtime.startedAt - a.runtime.startedAt);
		const terminal = runs.filter((run) => !isActive(run)).length;
		const rows = this.rows();
		if (this.getHeight() < 12) {
			const row = rows[Math.min(this.selected, Math.max(0, rows.length - 1))];
			return dashboardFrame("Agents", [
				` ${tabs([`Runs ${state.runs.length}`, `Groups ${state.groups.length}`, `Personas ${loadBuiltinAgents().length}`], this.tab, this.theme)}`,
				` ${row ? selectedRow(this.rowText(row), true, this.theme, Math.max(1, width - 6)) : "No records"}`,
				` ${this.theme.fg("dim", "←/→ view · j/k move · q close")}`,
			], this.theme, width, this.getHeight());
		}
		this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		const height = Math.max(12, this.getHeight() - 4);
		const listSize = Math.max(3, Math.min(12, height - 11));
		const window = pageWindow(rows, this.selected, listSize);
		const bodyWidth = Math.max(10, width - 6);
		const body = [
			` ${tabs([`Runs ${state.runs.length}`, `Groups ${state.groups.length}`, `Personas ${loadBuiltinAgents().length}`], this.tab, this.theme)}`,
			` ${this.theme.fg("muted", `active ${runs.length - terminal} · settled ${terminal}`)}  ${progressBar(terminal, Math.max(1, runs.length), Math.min(18, Math.max(8, Math.floor(width / 5))))}`,
			"",
			...window.values.map((row, index) => ` ${selectedRow(this.rowText(row), window.start + index === this.selected, this.theme, bodyWidth)}`),
			...(rows.length ? [] : [` ${this.theme.fg("dim", "No records in this view.")}`]),
			"",
			` ${this.theme.fg("accent", "Details")}`,
			...detailLines(this.detail(rows[this.selected]), bodyWidth, Math.max(2, height - listSize - 8)).map((line) => ` ${line}`),
			"",
			` ${this.theme.fg("dim", "←/→ tabs · j/k move · x cancel · c clear · q close")}`,
		];
		return dashboardFrame("Agents", body, this.theme, width, this.getHeight());
	}

	invalidate(): void {}

	private rows(): AgentRow[] {
		const state = this.service.list();
		if (this.tab === 0) return [...state.runs].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.runtime.startedAt - a.runtime.startedAt).map((value) => ({ kind: "run", value }));
		if (this.tab === 1) return state.groups.map((value) => ({ kind: "group", value }));
		return loadBuiltinAgents().map((value) => ({ kind: "persona", value }));
	}

	private rowText(row: AgentRow): string {
		if (row.kind === "persona") return `◇ ${row.value.name.padEnd(14)} ${row.value.write ? "write" : "read-only"} · ${row.value.description}`;
		if (row.kind === "group") return `${statusIcon(row.value.status)} ${row.value.status.padEnd(10)} group ${row.value.id.slice(-8)} · ${row.value.children.length} runs · ${row.value.pending.length} pending`;
		const run = row.value;
		const usage = run.runtime.usage;
		const tokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
		return `${statusIcon(run.runtime.status)} ${run.runtime.status.padEnd(10)} ${run.spec.persona.padEnd(14)} ${formatDuration((run.runtime.endedAt ?? Date.now()) - run.runtime.startedAt)} · ${formatCount(tokens)} tok · $${usage.costUsd.toFixed(3)} · ${run.spec.id.slice(-8)}`;
	}

	private detail(row: AgentRow | undefined): string {
		if (!row) return "Select a tab and row.";
		if (row.kind === "persona") return `${row.value.name}\n${row.value.description}\nAccess: ${row.value.write ? "write-capable" : "read-only"}\nTools: ${row.value.tools.join(", ") || "none"}`;
		if (row.kind === "group") return `ID: ${row.value.id}\nStatus: ${row.value.status}\nChildren: ${row.value.children.join(", ") || "none"}\nActive: ${row.value.active.join(", ") || "none"}\nFailures: ${row.value.launchFailures.join("; ") || "none"}`;
		const run = row.value;
		const worktree = run.spec.worktree ? `\nWorktree: ${run.spec.worktree.path} (${run.spec.worktree.branch})` : "";
		return `ID: ${run.spec.id}\nAgent identity: ${run.spec.agentId}\nTask: ${run.spec.task}${worktree}\nSession: ${run.runtime.sessionFile ?? "pending"}\nOutput/error: ${run.runtime.output || run.runtime.error || "pending"}`;
	}
}

function isActive(value: DelegateRun | SubagentGroup): boolean {
	return "children" in value ? value.status === "running" : ["starting", "running", "stopping"].includes(value.runtime.status);
}
