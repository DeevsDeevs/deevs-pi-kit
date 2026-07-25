import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("legacy runtime cutover", () => {
	it("ships only the owned Subagent, Mission, and Job runtimes", () => {
		for (const removed of ["extensions/processes", "extensions/subagents-v2", "extensions/subagents/v2", "extensions/mission/v2"]) {
			expect(existsSync(path.join(root, removed)), removed).toBe(false);
		}
		const extensionDirs = readdirSync(path.join(root, "extensions"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && existsSync(path.join(root, "extensions", entry.name, "index.ts")))
			.map((entry) => entry.name);
		expect(extensionDirs).toContain("jobs");
		expect(extensionDirs).toContain("subagents");
		expect(extensionDirs).toContain("mission");
		expect(extensionDirs).not.toContain("processes");
	});

	it("exposes only the replacement public model tools", () => {
		const subagents = readFileSync(path.join(root, "extensions/subagents/index.ts"), "utf8");
		const jobs = readFileSync(path.join(root, "extensions/jobs/index.ts"), "utf8");
		expect(subagents).toContain('name: "subagent"');
		expect(subagents).toContain('name: "subagent_wait"');
		expect(subagents).not.toMatch(/name:\s*"agent_/);
		expect(jobs).toContain('name: "job_start"');
		expect(jobs).toContain('name: "job_wait"');
		expect(jobs).toContain('name: "job_read"');
		expect(jobs).toContain('name: "job_stop"');
		expect(jobs).not.toMatch(/name:\s*"proc_/);
	});
});
