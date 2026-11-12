import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderTodoWidgetLines } from "../extensions/todos/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

describe("todo widget", () => {
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
