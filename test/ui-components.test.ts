import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { showTextViewer, TextViewer } from "../extensions/shared/text-viewer.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderTodoWidgetLines } from "../extensions/todos/ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { wikiResult } from "../extensions/wiki/tools.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

describe("shared compact UI", () => {
	it.each([1, 40, 80, 120])("renders the bounded text viewer at width %i", (width) => {
		const viewer = new TextViewer("Results", Array.from({ length: 40 }, (_, index) => `line ${index} content`).join("\n"), theme, () => undefined, () => undefined);
		const lines = viewer.render(width);
		expect(lines.length).toBeLessThanOrEqual(28);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		if (width >= 4) {
			expect(lines[0]).toContain("╭");
			expect(lines.at(-1)).toContain("╰");
		}
	});

	it("keeps the viewer within a short terminal and updates its page size after resize", () => {
		let pageSize = 4;
		const viewer = new TextViewer("Results", Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"), theme, () => undefined, () => undefined, () => pageSize);
		expect(viewer.render(40).length).toBeLessThanOrEqual(10);
		pageSize = 8;
		expect(viewer.render(40).length).toBeLessThanOrEqual(14);
	});

	it("uses structured notifications instead of TUI overlays in RPC mode", async () => {
		const notifications: string[] = [];
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: {
				notify(message: string) { notifications.push(message); },
				custom() { throw new Error("RPC must not open a TUI overlay"); },
			},
		} as unknown as ExtensionContext;
		await showTextViewer(ctx, "Results", "structured output");
		expect(notifications).toEqual(["structured output"]);
	});

	it.each(["print", "json"] as const)("emits bounded command output in %s mode", async (mode) => {
		const writes: string[] = [];
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { writes.push(String(value)); return true; }) as typeof process.stdout.write);
		try {
			const ctx = { mode, hasUI: false, ui: { notify() {} } } as unknown as ExtensionContext;
			await showTextViewer(ctx, "Results", "headless output");
			expect(writes.join("")).toContain("headless output");
			if (mode === "json") expect(() => JSON.parse(writes.join("").trim())).not.toThrow();
		} finally {
			write.mockRestore();
		}
	});

	it("renders expanded wiki context from its pages field", () => {
		const rendered = wikiResult({ path: "wiki", pages: [{ id: "one" }], context: "packed context" }, true, theme).render(80).join("\n");
		expect(rendered).toContain("context from 1 page(s)");
		expect(rendered).toContain("packed context");
	});

	it("keeps the Todo widget to summary, active item, and first blocker", () => {
		const todos = [
			{ id: "1", title: "active", status: "in_progress" as const },
			{ id: "2", title: "blocked", status: "blocked" as const },
			{ id: "3", title: "pending", status: "pending" as const },
			{ id: "4", title: "done", status: "done" as const },
		];
		const lines = renderTodoWidgetLines(todos, { total: 4, pending: 1, inProgress: 1, done: 1, blocked: 1 }, theme, 80);
		expect(lines).toHaveLength(3);
		expect(lines.join("\n")).toContain("active");
		expect(lines.join("\n")).toContain("blocked");
		expect(lines.join("\n")).not.toContain("pending");
	});
});
