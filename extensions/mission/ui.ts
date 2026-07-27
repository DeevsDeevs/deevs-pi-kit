import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { dashboardFrame, detailLines, progressBar, statusIcon, tabs } from "../shared/dashboard.ts";
import type { MissionState } from "./state.ts";
import type { MissionProgressRecord } from "./types.ts";

export class MissionDashboard implements Component {
	private tab = 0;
	private offset = 0;

	constructor(
		private readonly state: MissionState,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly getHeight: () => number,
		private readonly togglePause: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return this.done();
		if (matchesKey(data, Key.left) || matchesKey(data, "h")) { this.tab = (this.tab + 3) % 4; this.offset = 0; }
		if (matchesKey(data, Key.right) || matchesKey(data, "l") || matchesKey(data, Key.tab)) { this.tab = (this.tab + 1) % 4; this.offset = 0; }
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.offset = Math.max(0, this.offset - 1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.offset++;
		if (matchesKey(data, "p")) this.togglePause();
		this.requestRender();
	}

	render(width: number): string[] {
		const mission = this.state.readAny();
		if (!mission) return dashboardFrame("Mission", [` ${this.theme.fg("dim", "No Mission on this branch.")}`, "", ` ${this.theme.fg("dim", "q close")}`], this.theme, width, this.getHeight());
		const usage = this.state.readUsage();
		const progress = this.state.readProgress();
		if (this.getHeight() < 12) return dashboardFrame("Mission", [
			` ${statusIcon(mission.status)} ${mission.status.toUpperCase()} · ${mission.title}`,
			` tokens ${progressBar(usage.totalTokens, mission.tokenBudget, Math.min(10, Math.max(4, width - 20)))}`,
			` ${this.theme.fg("dim", "←/→ section · p pause/resume · q close")}`,
		], this.theme, width, this.getHeight());
		const bodyWidth = Math.max(10, width - 6);
		const height = Math.max(12, this.getHeight() - 4);
		const content = this.content(this.tab, bodyWidth, progress);
		const visible = content.slice(this.offset, this.offset + Math.max(4, height - 10));
		this.offset = Math.min(this.offset, Math.max(0, content.length - Math.max(4, height - 10)));
		const tokenBar = progressBar(usage.totalTokens, mission.tokenBudget, Math.min(18, Math.max(8, Math.floor(width / 6))));
		const costBar = progressBar(Math.round(usage.totalCostUsd * 100), mission.costBudgetUsd ? Math.round(mission.costBudgetUsd * 100) : undefined, Math.min(14, Math.max(6, Math.floor(width / 8))));
		const body = [
			` ${statusIcon(mission.status)} ${this.theme.fg(mission.status === "complete" ? "success" : mission.status === "active" ? "warning" : "muted", mission.status.toUpperCase())}  ${this.theme.fg("accent", mission.title)}`,
			` ${tabs(["Overview", `Requirements ${mission.requirements.length}`, `Progress ${progress.length}`, `Review ${mission.reviewStatus}`], this.tab, this.theme)}`,
			` tokens ${tokenBar}  cost ${costBar}`,
			"",
			...visible.map((line) => ` ${line}`),
			...(content.length > visible.length ? [` ${this.theme.fg("muted", `${this.offset + 1}-${this.offset + visible.length} / ${content.length}`)}`] : []),
			"",
			` ${this.theme.fg("dim", "←/→ sections · j/k scroll · p pause/resume · q close")}`,
		];
		return dashboardFrame("Mission", body, this.theme, width, this.getHeight());
	}

	invalidate(): void {}

	private content(tab: number, width: number, progress: MissionProgressRecord[]): string[] {
		const mission = this.state.readAny()!;
		if (tab === 0) return detailLines([
			`ID: ${mission.missionId} · objective v${mission.objectiveVersion}`,
			`Objective: ${mission.objective}`,
			`Chain: ${mission.chain}@${mission.chainBranch}`,
			`Artifacts: .missions/${mission.slug}`,
			`Reason: ${mission.lastReason ?? "—"}`,
			`Deadline: ${mission.wallDeadlineAt ? new Date(mission.wallDeadlineAt).toLocaleString() : "none"}`,
		].join("\n"), width, 200);
		if (tab === 1) return mission.requirements.flatMap((requirement, index) => detailLines(`${index + 1}. ○ ${requirement}`, width, 20));
		if (tab === 2) {
			if (!progress.length) return [this.theme.fg("dim", "No progress records.")];
			return [...progress].reverse().flatMap((item) => detailLines(`${new Date(item.at).toLocaleTimeString()}  ${item.summary}\n  evidence ${item.evidence.length} · validation ${item.validation.length} · remaining ${item.remaining.length}`, width, 12));
		}
		return detailLines([
			`Status: ${mission.reviewStatus}`,
			`Run: ${mission.reviewRunId ?? "none"}`,
			`Reason: ${mission.reviewReason ?? "—"}`,
			`Skipped: ${mission.reviewSkippedReason ?? "no"}`,
		].join("\n"), width, 100);
	}
}
