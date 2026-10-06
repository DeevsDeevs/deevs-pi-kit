import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type OverlayOptions } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { framePanelLines } from "./panel.ts";

export const FULL_SCREEN_OVERLAY: OverlayOptions = { width: "100%", maxHeight: "100%", anchor: "center", margin: 1 };

export function selectedRow(text: string, selected: boolean, theme: Theme, width: number): string {
	const prefix = selected ? "› " : "  ";
	const clipped = truncateToWidth(`${prefix}${text}`, Math.max(1, width), "…", true);
	return selected ? theme.bg("selectedBg", theme.fg("text", clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))))) : clipped;
}

export function detailLines(text: string, width: number, maxLines: number): string[] {
	return text.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width))).slice(0, Math.max(0, maxLines));
}

export function dashboardFrame(title: string, body: string[], theme: Theme, width: number, height?: number): string[] {
	if (height === undefined) return framePanelLines(title, body, theme, Math.max(1, width));
	const bodyHeight = Math.max(1, Math.floor(height) - 2);
	const fixed = body.slice(0, bodyHeight);
	while (fixed.length < bodyHeight) fixed.push("");
	return framePanelLines(title, fixed, theme, Math.max(1, width));
}

export function pageWindow<T>(values: T[], selected: number, size: number) {
	if (!values.length) return { values: [], start: 0, selected: 0 };
	const safeSelected = Math.max(0, Math.min(selected, values.length - 1));
	const start = Math.max(0, Math.min(safeSelected - Math.floor(size / 2), values.length - size));
	return { values: values.slice(start, start + size), start, selected: safeSelected };
}

export function statusIcon(status: string): string {
	if (["completed", "complete", "saved", "clear"].includes(status)) return "✓";
	if (["starting", "running", "stopping", "active"].includes(status)) return "●";
	if (["queued", "pending", "due", "paused"].includes(status)) return "○";
	if (["cancelled", "skipped", "cleared"].includes(status)) return "–";
	return "✗";
}
