import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KITTY_ALT_ENTER = /^\x1b\[13;3(?::([123]))?u$/;
const MODIFY_OTHER_KEYS_ALT_ENTER = "\x1b[27;3;13~";

export function normalizeHerdrShiftEnter(data: string): string | null {
	if (data === "\x1b\r" || data === MODIFY_OTHER_KEYS_ALT_ENTER) return "\n";

	const kitty = data.match(KITTY_ALT_ENTER);
	if (!kitty) return data;
	return kitty[1] === "3" ? null : "\n";
}

export default function herdrCompatExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || process.env.HERDR_ENV !== "1") return;

		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				const normalized = normalizeHerdrShiftEnter(data);
				if (normalized !== null) handleInput(normalized);
			};
			return editor;
		});
	});
}
