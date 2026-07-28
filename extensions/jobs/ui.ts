import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { dashboardFrame, detailLines, formatCount, pageWindow, progressBar, selectedRow, statusIcon, tabs } from "../shared/dashboard.ts";
import { formatDuration } from "../shared/runtime-ui.ts";
import type { JobManager } from "./manager.ts";
import type { JobRecord } from "./types.ts";

export class JobsDashboard implements Component {
	private tab = 0;
	private selected = 0;

	constructor(
		private readonly manager: JobManager,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly getHeight: () => number,
		private readonly stop: (id: string) => void,
		private readonly clear: (id: string) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return this.done();
		if (matchesKey(data, Key.left) || matchesKey(data, "h") || matchesKey(data, Key.right) || matchesKey(data, "l") || matchesKey(data, Key.tab)) { this.tab = (this.tab + 1) % 2; this.selected = 0; }
		const rows = this.rows();
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
		const row = rows[this.selected];
		if (matchesKey(data, "x") && row && isActive(row)) this.stop(row.spec.id);
		if (matchesKey(data, "c") && row && !isActive(row)) this.clear(row.spec.id);
		this.requestRender();
	}

	render(width: number): string[] {
		const all = this.manager.list();
		const active = all.filter(isActive);
		const rows = this.rows();
		if (this.getHeight() < 12) {
			const row = rows[Math.min(this.selected, Math.max(0, rows.length - 1))];
			return dashboardFrame("Jobs", [
				` ${tabs([`Active ${active.length}`, `History ${all.length - active.length}`], this.tab, this.theme)}`,
				` ${row ? selectedRow(this.rowText(row), true, this.theme, Math.max(1, width - 6)) : "No Jobs"}`,
				` ${this.theme.fg("dim", "←/→ view · j/k move · q close")}`,
			], this.theme, width, this.getHeight());
		}
		this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		const height = Math.max(12, this.getHeight() - 4);
		const listSize = Math.max(3, Math.min(11, height - 12));
		const window = pageWindow(rows, this.selected, listSize);
		const bodyWidth = Math.max(10, width - 6);
		const selected = rows[this.selected];
		const totalBuffered = all.reduce((sum, job) => sum + job.runtime.bufferedBytes, 0);
		const body = [
			` ${tabs([`Active ${active.length}`, `History ${all.length - active.length}`], this.tab, this.theme)}`,
			` ${this.theme.fg("muted", `${all.length} jobs · ${formatCount(totalBuffered)} buffered bytes`)}`,
			"",
			...window.values.map((job, index) => ` ${selectedRow(this.rowText(job), window.start + index === this.selected, this.theme, bodyWidth)}`),
			...(rows.length ? [] : [` ${this.theme.fg("dim", this.tab === 0 ? "No active Jobs." : "No Job history.")}`]),
			"",
			` ${this.theme.fg("accent", "Selected Job")}`,
			...detailLines(this.detail(selected, bodyWidth), bodyWidth, Math.max(3, height - listSize - 8)).map((line) => ` ${line}`),
			"",
			` ${this.theme.fg("dim", "←/→ tabs · j/k move · x stop · c clear · q close")}`,
		];
		return dashboardFrame("Jobs", body, this.theme, width, this.getHeight());
	}

	invalidate(): void {}

	private rows(): JobRecord[] {
		const values = this.manager.list();
		return values.filter((job) => this.tab === 0 ? isActive(job) : !isActive(job));
	}

	private rowText(job: JobRecord): string {
		const elapsed = (job.runtime.endedAt ?? Date.now()) - job.runtime.startedAt;
		const ready = job.runtime.ready ? "ready" : job.spec.readyPattern ? "waiting" : "";
		return `${statusIcon(job.runtime.status)} ${job.runtime.status.padEnd(10)} ${job.spec.name} · ${formatDuration(elapsed)}${ready ? ` · ${ready}` : ""} · ${formatCount(job.runtime.bufferedBytes)} buf · ${job.spec.id.slice(-8)}`;
	}

	private detail(job: JobRecord | undefined, width: number): string {
		if (!job) return "Select a Job row.";
		const elapsed = (job.runtime.endedAt ?? Date.now()) - job.runtime.startedAt;
		const output = this.manager.read({ id: job.spec.id, maxBytes: Math.max(1_024, width * 20) }).chunks.map((chunk) => chunk.text).join("").trim();
		return [
			`${progressBar(elapsed, job.spec.timeoutMs, Math.min(24, Math.max(10, Math.floor(width / 4))))}  ${formatDuration(elapsed)} / ${formatDuration(job.spec.timeoutMs)}`,
			`ID: ${job.spec.id} · PID: ${job.runtime.pid ?? "settled"} · exit: ${job.runtime.exitCode ?? "—"}`,
			`cwd: ${job.spec.cwd}`,
			`command: ${job.spec.command ?? job.spec.argv?.join(" ") ?? ""}`,
			`buffer: ${job.runtime.bufferedBytes}/${job.spec.maxBufferBytes} bytes · dropped ${job.runtime.droppedBytes}`,
			`output tail: ${output || job.runtime.error || "(none)"}`,
		].join("\n");
	}
}

function isActive(job: JobRecord): boolean {
	return ["starting", "running", "stopping"].includes(job.runtime.status);
}
