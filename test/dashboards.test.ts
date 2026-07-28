import { describe, expect, it } from "vitest";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { progressBar } from "../extensions/shared/dashboard.ts";
import { AgentsDashboard } from "../extensions/subagents/ui.ts";
import { JobsDashboard } from "../extensions/jobs/ui.ts";
import { MissionDashboard } from "../extensions/mission/ui.ts";
import { ChainsDashboard } from "../extensions/chains/ui.ts";
import { renderWorkflowFleet, renderWorkflowWidget } from "../extensions/workflow/ui.ts";
import type { WorkflowDetails } from "../extensions/workflow/index.ts";
import type { SubagentService } from "../extensions/subagents/service.ts";
import type { JobManager } from "../extensions/jobs/manager.ts";
import type { MissionState } from "../extensions/mission/state.ts";

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

	it("renders useful Job progress, command, and output", () => {
		const now = Date.now();
		const job = {
			spec: { id: "j_test_12345678", name: "check", cwd: "/repo", argv: ["npm", "test"], timeoutMs: 60_000, maxBufferBytes: 1_024 },
			runtime: { status: "running", ready: true, startedAt: now - 5_000, bufferedBytes: 12, droppedBytes: 0, pid: 42 },
		};
		const manager = { list: () => [job], read: () => ({ chunks: [{ text: "tests running" }] }) } as unknown as JobManager;
		const dashboard = new JobsDashboard(manager, theme, noop, noop, () => 30, noop, noop);
		const lines = dashboard.render(80);
		bounded(lines, 80);
		dashboard.handleInput(Key.right);
		expect(dashboard.render(80)).toHaveLength(lines.length);
		expect(new JobsDashboard(manager, theme, noop, noop, () => 8, noop, noop).render(40).length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("npm test");
		expect(lines.join("\n")).toContain("tests running");
	});

	it("renders Mission sections and budget bars instead of a text dump", () => {
		const state = {
			readAny: () => ({ missionId: "m_test", status: "paused", title: "UI Mission", objective: "Make status readable", objectiveVersion: 2, requirements: ["Readable requirements"], chain: "kit", chainBranch: "main", slug: "ui", reviewStatus: "changes_requested", tokenBudget: 1000, costBudgetUsd: 5, lastReason: "/pause" }),
			readUsage: () => ({ totalTokens: 500, totalCostUsd: 2, mainTokens: 0, subagentTokens: 0, mainCostUsd: 0, subagentCostUsd: 0 }),
			readProgress: () => [],
		} as unknown as MissionState;
		const dashboard = new MissionDashboard(state, theme, noop, noop, () => 30, noop);
		const lines = dashboard.render(80);
		bounded(lines, 80);
		dashboard.handleInput(Key.right);
		expect(dashboard.render(80)).toHaveLength(lines.length);
		expect(new MissionDashboard(state, theme, noop, noop, () => 8, noop).render(40).length).toBeLessThanOrEqual(8);
		expect(lines.join("\n")).toContain("Overview");
		expect(lines.join("\n")).toContain("50%");
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

	it("renders Workflow queued and running progress below the editor", () => {
		const details = {
			id: "wf_test_12345678", status: "running", startedAt: Date.now() - 1000, activeAgents: 1, completedAgents: 0, runs: [],
			agents: [{ id: "queued:1", persona: "tester", status: "queued", startedAt: Date.now() }, { id: "a_2", persona: "reviewer", status: "running", startedAt: Date.now() - 1000 }],
		} as WorkflowDetails;
		const lines = renderWorkflowWidget(details, theme);
		expect(lines.join("\n")).toContain("Workflow");
		expect(renderWorkflowWidget(details, theme, 20).every((line) => visibleWidth(line) <= 20)).toBe(true);
		expect(lines.join("\n")).toContain("queued");
		expect(lines.join("\n")).toContain("running");
	});

	it("combines concurrent Workflows into one bounded fleet view", () => {
		const workflows = Array.from({ length: 9 }, (_, index) => ({
			id: `wf_test_${String(index).padStart(8, "0")}`, status: "running", startedAt: Date.now() - 1000, activeAgents: 1, completedAgents: 0, runs: [],
			agents: [{ id: `a_${index}`, persona: "tester", status: index === 0 ? "failed" : "running", startedAt: Date.now() - 1000 }],
		})) as WorkflowDetails[];
		const lines = renderWorkflowFleet(workflows, theme, 48);
		expect(lines).toHaveLength(8);
		expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
		expect(lines.join("\n")).toContain("Workflows 9 active");
		expect(lines.at(-1)).toContain("3 more workflows");
	});

	it("renders bounded textual progress bars", () => {
		expect(progressBar(5, 10, 10)).toBe("█████░░░░░ 50%");
	});
});
