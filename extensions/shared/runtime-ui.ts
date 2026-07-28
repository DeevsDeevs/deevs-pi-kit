import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { RUNTIME_EVENT_ENTRY, type RuntimeEvent, type RuntimeEventOperation, type RuntimeTerminalStatus } from "./runtime-events.ts";

export function registerRuntimeEventRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<RuntimeEventOperation>(RUNTIME_EVENT_ENTRY, (entry, { expanded }, theme) => {
		if (entry.data?.type !== "emit") return undefined;
		return new Text(formatRuntimeEvent(entry.data.event, theme, expanded), 0, 0);
	});
}

export function formatRuntimeEvent(event: RuntimeEvent, theme: Theme, expanded: boolean): string {
	const headline = `${statusText(event.status, theme)} ${theme.fg("accent", event.source.kind)} ${theme.fg("muted", event.source.id)} ${event.summary}`;
	if (!expanded) return headline;
	const details = [
		`generation: ${event.source.generation}`,
		`event: ${event.id}`,
		`created: ${new Date(event.createdAt).toISOString()}`,
	];
	if (event.usage) details.push(`usage: ${formatUsage(event.usage.inputTokens + event.usage.outputTokens, event.usage.costUsd)}`);
	if (event.artifactRef) details.push(`artifact: ${event.artifactRef}`);
	return `${headline}\n${details.map((line) => theme.fg("dim", `  ${line}`)).join("\n")}`;
}

export function statusGlyph(status: RuntimeTerminalStatus): string {
	if (status === "completed") return "✓";
	if (status === "partial") return "◐";
	if (status === "blocked") return "!";
	if (status === "cancelled") return "■";
	if (status === "timeout") return "◷";
	if (status === "lost") return "?";
	return "✗";
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function formatUsage(tokens: number, costUsd: number): string {
	const tokenText = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)).toLocaleString("en-US") : "?";
	const costText = Number.isFinite(costUsd) ? `$${Math.max(0, costUsd).toFixed(4)}` : "$?";
	return `${tokenText} tokens · ${costText}`;
}

export function compactLine(text: string, width: number): string {
	return truncateToWidth(text.replace(/\s+/g, " ").trim(), Math.max(1, width));
}

function statusText(status: RuntimeTerminalStatus, theme: Theme): string {
	const text = `${statusGlyph(status)} ${status}`;
	if (status === "completed") return theme.fg("success", text);
	if (status === "partial" || status === "timeout" || status === "limited" || status === "blocked") return theme.fg("warning", text);
	if (status === "cancelled" || status === "lost") return theme.fg("muted", text);
	return theme.fg("error", text);
}
