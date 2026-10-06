import { describe, expect, it } from "vitest";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { ChainsDashboard } from "../extensions/chains/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
const noop = () => undefined;

function bounded(lines: string[], width: number): void {
	expect(lines.length).toBeGreaterThan(5);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
}

describe("bespoke dashboards", () => {
	it("renders Chain checkpoint, rows, and selected metadata", () => {
		const chains = [{ chain: "deevs-pi-kit", count: 2, latest: { chain: "deevs-pi-kit", branch: "main", filename: "latest.md", title: "Latest", nextStep: "Ship", ageDays: 0, stale: false }, branches: [] }];
		const checkpoint = { status: "due", chain: "deevs-pi-kit", branch: "main", dueReasons: ["review"], updatedAt: Date.now(), contextPressureHandled: false };
		let loads = 0;
		const dashboard = new ChainsDashboard(chains as never, checkpoint as never, theme, noop, noop, () => 30, async () => "preview", () => { loads++; });
		const lines = dashboard.render(80);
		bounded(lines, 80);
		dashboard.handleInput(Key.enter);
		expect(dashboard.render(80)).toHaveLength(lines.length);
		dashboard.handleInput("l");
		expect(loads).toBe(0);
		dashboard.handleInput("L");
		expect(loads).toBe(1);
		expect(new ChainsDashboard(chains as never, checkpoint as never, theme, noop, noop, () => 8, async () => "preview", noop).render(40).length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("deevs-pi-kit@main");
		expect(lines.join("\n")).toContain("Ship");
	});
});
