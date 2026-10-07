import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { framePanelLines } from "../shared/panel.ts";
import { checkpointLabel, type ChainCheckpointState } from "./checkpoint.ts";
import type { ChainBranchInfo, ChainListItem } from "./types.ts";

type ChainRow = { kind: "chain"; chain: ChainListItem } | { kind: "branch"; chain: ChainListItem; branch: ChainBranchInfo };

export const FULL_SCREEN_OVERLAY: OverlayOptions = { width: "100%", maxHeight: "100%", anchor: "center", margin: 1 };
const STATUS_ICONS = { idle: "●", saved: "✓", due: "○" } satisfies Record<ChainCheckpointState["status"], string>;

export class ChainsDashboard implements Component {
	private selected = 0;
	private expandedChain?: string;
	private preview = "";
	private loading = false;
	private previewRequest = 0;

	constructor(
		private readonly chains: ChainListItem[],
		private readonly checkpoint: ChainCheckpointState,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly getHeight: () => number,
		private readonly loadPreview: (chain: string, branch?: string) => Promise<string>,
		private readonly loadTurn: (chain: string, branch?: string) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return this.done();
		const rows = this.rows();
		const previous = this.selected;
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selected = Math.min(Math.max(0, rows.length - 1), this.selected + 1);
		if (this.selected !== previous) { this.preview = ""; this.loading = false; this.previewRequest++; }
		const row = rows[this.selected];
		if ((matchesKey(data, Key.enter) || data === " ") && row) {
			if (row.kind === "chain" && row.chain.branches?.length) {
				this.expandedChain = this.expandedChain === row.chain.chain ? undefined : row.chain.chain;
				this.preview = "";
			} else this.previewRow(row);
		}
		if (matchesKey(data, "v") && row) this.previewRow(row);
		if (data === "L" && row) this.loadTurn(row.chain.chain, row.kind === "branch" ? row.branch.branch : row.chain.latest?.branch);
		this.requestRender();
	}

	render(width: number): string[] {
		const rows = this.rows();
		this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
		if (this.getHeight() < 12) {
			const row = rows[this.selected];
			return frame([
				` ${this.checkpoint.chain ? `${STATUS_ICONS[this.checkpoint.status]} ${this.checkpoint.chain}@${this.checkpoint.branch}` : "○ no checkpoint"}`,
				` ${row ? selectedRow(this.rowText(row), true, this.theme, Math.max(1, width - 6)) : "No Chains"}`,
				` ${this.theme.fg("dim", "j/k move · enter expand · q close")}`,
			], this.theme, width, this.getHeight());
		}
		const height = Math.max(12, this.getHeight() - 4);
		const listSize = Math.max(4, Math.min(13, height - 12));
		const window = pageWindow(rows, this.selected, listSize);
		const bodyWidth = Math.max(10, width - 6);
		const row = rows[this.selected];
		const label = checkpointLabel(this.checkpoint);
		const checkpoint = label ? `${STATUS_ICONS[this.checkpoint.status]} ${label}` : "○ no active checkpoint";
		const body = [
			` ${this.theme.fg(this.checkpoint.status === "due" ? "warning" : "muted", checkpoint)}`,
			` ${this.theme.fg("muted", `${this.chains.length} chains · ${this.chains.reduce((sum, item) => sum + item.count, 0)} links`)}`,
			"",
			...window.values.map((item, index) => ` ${selectedRow(this.rowText(item), window.start + index === this.selected, this.theme, bodyWidth)}`),
			...(rows.length ? [] : [` ${this.theme.fg("dim", "No Chains found.")}`]),
			"",
			` ${this.theme.fg("accent", this.loading ? "Loading preview…" : "Selected Chain")}`,
			...detailLines(this.preview || this.detail(row), bodyWidth, Math.max(3, height - listSize - 8)).map((line) => ` ${line}`),
			"",
			` ${this.theme.fg("dim", "j/k move · enter expand · v preview · L load next turn · q close")}`,
		];
		return frame(body, this.theme, width, this.getHeight());
	}

	invalidate(): void {}

	private rows(): ChainRow[] {
		return this.chains.flatMap((chain) => [
			{ kind: "chain", chain } satisfies ChainRow,
			...(this.expandedChain === chain.chain ? (chain.branches ?? []).map((branch) => ({ kind: "branch", chain, branch } satisfies ChainRow)) : []),
		]);
	}

	private rowText(row: ChainRow): string {
		if (row.kind === "branch") return `  ↳ ${row.branch.branch} · ${row.branch.count} links · ${row.branch.latest?.title ?? "empty"}`;
		const expanded = this.expandedChain === row.chain.chain ? "▾" : row.chain.branches?.length ? "▸" : " ";
		return `${expanded} ${row.chain.chain} · ${row.chain.count} links · ${row.chain.latest?.title ?? "empty"}`;
	}

	private detail(row: ChainRow | undefined): string {
		if (!row) return "Select a Chain.";
		const latest = row.kind === "branch" ? row.branch.latest : row.chain.latest;
		return `Chain: ${row.chain.chain}${row.kind === "branch" ? `@${row.branch.branch}` : ""}\nLatest: ${latest?.filename ?? "none"}\nTitle: ${latest?.title ?? "none"}\nNext: ${latest?.nextStep ?? "not recorded"}\nAge: ${latest?.ageDays ?? "?"} day(s)${latest?.stale ? " · stale" : ""}`;
	}

	private previewRow(row: ChainRow): void {
		const request = ++this.previewRequest;
		this.loading = true;
		this.preview = "";
		this.requestRender();
		void this.loadPreview(row.chain.chain, row.kind === "branch" ? row.branch.branch : row.chain.latest?.branch)
			.then((content) => { if (request === this.previewRequest) this.preview = content; })
			.catch((error) => { if (request === this.previewRequest) this.preview = error instanceof Error ? error.message : String(error); })
			.finally(() => { if (request === this.previewRequest) { this.loading = false; this.requestRender(); } });
	}
}

function selectedRow(text: string, selected: boolean, theme: Theme, width: number): string {
	const prefix = selected ? "› " : "  ";
	const clipped = truncateToWidth(`${prefix}${text}`, Math.max(1, width), "…", true);
	return selected ? theme.bg("selectedBg", theme.fg("text", clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))))) : clipped;
}

function detailLines(text: string, width: number, maxLines: number): string[] {
	return text.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width))).slice(0, Math.max(0, maxLines));
}

/** The body padded or cut to fill `height` inside the frame. */
function frame(body: string[], theme: Theme, width: number, height: number): string[] {
	const bodyHeight = Math.max(1, Math.floor(height) - 2);
	const fixed = body.slice(0, bodyHeight);
	while (fixed.length < bodyHeight) fixed.push("");
	return framePanelLines("Chains", fixed, theme, Math.max(1, width));
}

function pageWindow<T>(values: T[], selected: number, size: number) {
	if (!values.length) return { values: [], start: 0, selected: 0 };
	const safeSelected = Math.max(0, Math.min(selected, values.length - 1));
	const start = Math.max(0, Math.min(safeSelected - Math.floor(size / 2), values.length - size));
	return { values: values.slice(start, start + size), start, selected: safeSelected };
}
