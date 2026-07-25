import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export async function showTextViewer(ctx: ExtensionContext, title: string, content: string): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		const bounded = content.length > 4_000 ? `${content.slice(0, 4_000)}\n[truncated]` : content;
		if (ctx.mode === "print") process.stdout.write(`${bounded}\n`);
		else if (ctx.mode === "json") process.stdout.write(`${JSON.stringify({ type: "extension_output", title, content: bounded })}\n`);
		else ctx.ui.notify(bounded, "info");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new TextViewer(title, content, theme, () => done(undefined), () => tui.requestRender()), {
		overlay: true,
		overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center", margin: 1 },
	});
}

export class TextViewer implements Component {
	private offset = 0;
	private readonly pageSize = 24;

	constructor(private readonly title: string, private readonly content: string, private readonly theme: Theme, private readonly done: () => void, private readonly requestRender: () => void) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.offset = Math.max(0, this.offset - 1);
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.offset++;
		if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - this.pageSize);
		if (matchesKey(data, Key.pageDown)) this.offset += this.pageSize;
		this.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const bodyWidth = Math.max(1, safeWidth - 2);
		const lines = this.content.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth));
		const maxOffset = Math.max(0, lines.length - this.pageSize);
		this.offset = Math.min(this.offset, maxOffset);
		const visible = lines.slice(this.offset, this.offset + this.pageSize).map((line) => truncateToWidth(` ${line}`, safeWidth));
		const header = truncateToWidth(`${this.theme.fg("accent", this.theme.bold(this.title))} ${this.theme.fg("dim", `${this.offset + 1}-${Math.min(lines.length, this.offset + visible.length)}/${lines.length}`)}`, safeWidth);
		const footer = truncateToWidth(this.theme.fg("dim", " ↑↓/jk scroll · PgUp/PgDn · q close"), safeWidth);
		return [header, "", ...visible, "", footer];
	}

	invalidate(): void {}
}
