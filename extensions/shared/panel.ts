import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

export function framePanelLines(title: string, content: string[], theme: Theme, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (safeWidth < 4) return [title, ...content].map((line) => truncateToWidth(line, safeWidth, "", true));
	const innerWidth = safeWidth - 2;
	const rawLabel = truncateToWidth(` ${title} `, innerWidth, "", true);
	const labelWidth = visibleWidth(rawLabel);
	const top = theme.fg("border", "╭")
		+ theme.fg("accent", theme.bold(rawLabel))
		+ theme.fg("border", `${"─".repeat(Math.max(0, innerWidth - labelWidth))}╮`);
	const body = content.map((line) => {
		const text = truncateToWidth(line, innerWidth, "…", true);
		return theme.fg("border", "│") + text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text))) + theme.fg("border", "│");
	});
	return [top, ...body, theme.fg("border", `╰${"─".repeat(innerWidth)}╯`)];
}
