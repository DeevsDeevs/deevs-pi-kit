import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import herdrCompatExtension, { normalizeHerdrShiftEnter } from "../extensions/herdr-compat/index.ts";

const originalHerdrEnv = process.env.HERDR_ENV;

afterEach(() => {
	if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = originalHerdrEnv;
});

describe("Herdr compatibility", () => {
	it.each([
		["legacy ESC CR", "\x1b\r", "\n"],
		["Kitty Alt+Enter", "\x1b[13;3u", "\n"],
		["Kitty Alt+Enter press", "\x1b[13;3:1u", "\n"],
		["Kitty Alt+Enter repeat", "\x1b[13;3:2u", "\n"],
		["Kitty Alt+Enter release", "\x1b[13;3:3u", null],
		["modifyOtherKeys Alt+Enter", "\x1b[27;3;13~", "\n"],
		["real Kitty Shift+Enter", "\x1b[13;2:1u", "\x1b[13;2:1u"],
		["plain Enter", "\r", "\r"],
	] as const)("normalizes %s", (_label, input, expected) => {
		expect(normalizeHerdrShiftEnter(input)).toBe(expected);
	});

	it("wraps an existing editor only in a Herdr TUI session", () => {
		process.env.HERDR_ENV = "1";
		let onSessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
		let editorFactory: ((...args: unknown[]) => { handleInput(data: string): void }) | undefined;
		const handleInput = vi.fn();
		const editor = { handleInput };
		const pi = {
			on(name: string, handler: unknown) {
				if (name === "session_start") onSessionStart = handler as typeof onSessionStart;
			},
		} as unknown as ExtensionAPI;
		herdrCompatExtension(pi);

		const ctx = {
			mode: "tui",
			ui: {
				getEditorComponent: () => () => editor,
				setEditorComponent: (factory: typeof editorFactory) => { editorFactory = factory; },
			},
		} as unknown as ExtensionContext;
		onSessionStart!({}, ctx);
		const wrapped = editorFactory!({}, {}, {});
		wrapped.handleInput("\x1b[13;3:1u");
		wrapped.handleInput("\x1b[13;3:3u");

		expect(handleInput).toHaveBeenCalledOnce();
		expect(handleInput).toHaveBeenCalledWith("\n");
	});

	it("leaves non-Herdr sessions unchanged", () => {
		delete process.env.HERDR_ENV;
		let onSessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
		const setEditorComponent = vi.fn();
		const pi = {
			on(name: string, handler: unknown) {
				if (name === "session_start") onSessionStart = handler as typeof onSessionStart;
			},
		} as unknown as ExtensionAPI;
		herdrCompatExtension(pi);

		onSessionStart!({}, {
			mode: "tui",
			ui: { setEditorComponent },
		} as unknown as ExtensionContext);

		expect(setEditorComponent).not.toHaveBeenCalled();
	});
});
