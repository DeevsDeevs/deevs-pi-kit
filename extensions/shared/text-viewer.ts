import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { framePanelLines } from "./panel.ts";

export async function showTextViewer(ctx: ExtensionContext, title: string, content: string): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		const bounded = content.length > 4_000 ? `${content.slice(0, 4_000)}\n[truncated]` : content;
		if (ctx.mode === "print") process.stdout.write(`${bounded}\n`);
		else if (ctx.mode === "json") process.stdout.write(`${JSON.stringify({ type: "extension_output", title, content: bounded })}\n`);
		else ctx.ui.notify(bounded, "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TextViewer(
		title,
		content,
		theme,
		() => done(undefined),
		() => tui.requestRender(),
		() => Math.max(4, Math.min(20, tui.terminal.rows - 10)),
	), {
		overlay: true,
		overlayOptions: { width: "100%", minWidth: 48, maxHeight: "85%", anchor: "center", margin: 0 },
	});
}

export class TextViewer implements Component {
	private offset = 0;

	constructor(
		private readonly title: string,
		private readonly content: string,
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly getPageSize: () => number = () => 20,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.offset = Math.max(0, this.offset - 1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.offset++;
		const pageSize = this.getPageSize();
		if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - pageSize);
		if (matchesKey(data, Key.pageDown)) this.offset += pageSize;
		if (matchesKey(data, Key.home)) this.offset = 0;
		if (matchesKey(data, Key.end)) this.offset = Number.MAX_SAFE_INTEGER;
		this.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const bodyWidth = Math.max(1, safeWidth - 4);
		const lines = this.content.replace(/(?:\r?\n)+$/, "").split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth));
		const pageSize = this.getPageSize();
		const maxOffset = Math.max(0, lines.length - pageSize);
		this.offset = Math.min(this.offset, maxOffset);
		const visible = lines.slice(this.offset, this.offset + pageSize).map((line) => ` ${truncateToWidth(line, bodyWidth)}`);
		const end = Math.min(lines.length, this.offset + visible.length);
		const scrollable = lines.length > pageSize;
		return framePanelLines(this.title, [
			...(scrollable ? [` ${this.theme.fg("muted", `${lines.length} lines · ${this.offset + 1}-${end}`)}`, ""] : []),
			...visible,
			"",
			` ${this.theme.fg("dim", scrollable ? "up/down or j/k scroll | page up/down | home/end | esc/q close" : "esc/q close")}`,
		], this.theme, safeWidth);
	}

	invalidate(): void {}
}
