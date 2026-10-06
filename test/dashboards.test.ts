import { describe, expect, it } from "vitest";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { progressBar } from "../extensions/shared/dashboard.ts";
import { AgentsDashboard } from "../extensions/subagents/ui.ts";
import { ChainsDashboard } from "../extensions/chains/ui.ts";
import type { SubagentService } from "../extensions/subagents/service.ts";

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
	it("renders responsive Agents list/detail sections", () => {
		const now = Date.now();
		const run = {
			spec: { id: "a_test_12345678", agentId: "sa_test", persona: "tester", task: "verify dashboard", limits: {}, artifactsDir: "/tmp/a" },
			runtime: { status: "running", startedAt: now - 1_000, usage: { inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0.01 } },
		};
		const service = { list: () => ({ runs: [run], groups: [] }) } as unknown as SubagentService;
		const dashboard = new AgentsDashboard(service, theme, noop, noop, () => 30, noop, noop);
		const lines = dashboard.render(80);
		bounded(lines, 80);
		dashboard.handleInput(Key.right);
		expect(dashboard.render(80)).toHaveLength(lines.length);
		expect(new AgentsDashboard(service, theme, noop, noop, () => 8, noop, noop).render(40).length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("Runs 1");
		expect(lines.join("\n")).toContain("verify dashboard");
	});

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

	it("renders bounded textual progress bars", () => {
		expect(progressBar(5, 10, 10)).toBe("█████░░░░░ 50%");
	});
});
