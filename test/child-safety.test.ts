import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import childSafetyRuntime from "../extensions/subagents/child-safety-runtime.ts";

describe("read-only child tools", () => {
	it("provides bounded project-only listing and search without bash", async () => {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }>();
		const pi = {
			registerTool(tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }> }) { tools.set(tool.name, tool); },
			on() {},
		} as unknown as ExtensionAPI;
		childSafetyRuntime(pi);
		expect([...tools.keys()]).toEqual(["safe_read", "safe_list", "review_report", "safe_search", "safe_git"]);
		const read = await tools.get("safe_read")!.execute("call", { path: "package.json", maxBytes: 200 });
		expect(read.content[0]?.text).toContain("deevs-pi-kit");
		const listed = await tools.get("safe_list")!.execute("call", { path: "extensions/subagents", maxDepth: 1, maxResults: 20 });
		expect(listed.content[0]?.text).toContain("executor.ts");
		const searched = await tools.get("safe_search")!.execute("call", { path: "extensions/subagents", query: "childSafetyRuntime", maxResults: 10 });
		expect(searched.content[0]?.text).toContain("child-safety-runtime.ts");

		const local = path.join(process.cwd(), `.safe-read-test-${process.pid}`);
		const outside = mkdtempSync(path.join(tmpdir(), "safe-read-outside-"));
		const artifacts = mkdtempSync(path.join(tmpdir(), "review-report-"));
		const previousArtifacts = process.env.DEEVS_PI_SUBAGENT_ARTIFACTS;
		try {
			process.env.DEEVS_PI_SUBAGENT_ARTIFACTS = artifacts;
			await tools.get("review_report")!.execute("call", { verdict: "clear", overallExplanation: "ok", findings: [] });
			expect(JSON.parse(readFileSync(path.join(artifacts, "review-report.json"), "utf8"))).toMatchObject({ version: 1, verdict: "clear" });
			mkdirSync(local);
			writeFileSync(path.join(local, "large.txt"), "x".repeat(300_000));
			writeFileSync(path.join(outside, "secret.txt"), "secret");
			symlinkSync(path.join(outside, "secret.txt"), path.join(local, "escape.txt"));
			const bounded = await tools.get("safe_read")!.execute("call", { path: path.relative(process.cwd(), path.join(local, "large.txt")), offset: 200_000, maxBytes: 100 });
			expect(bounded.content[0]?.text).toContain("[truncated; next offset 200100]");
			expect(bounded.content[0]?.text.length).toBeLessThan(200);
			await expect(tools.get("safe_read")!.execute("call", { path: path.relative(process.cwd(), path.join(local, "escape.txt")) })).rejects.toThrow("outside");
		} finally {
			if (previousArtifacts === undefined) delete process.env.DEEVS_PI_SUBAGENT_ARTIFACTS;
			else process.env.DEEVS_PI_SUBAGENT_ARTIFACTS = previousArtifacts;
			rmSync(local, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
			rmSync(artifacts, { recursive: true, force: true });
		}
		await expect(tools.get("safe_list")!.execute("call", { path: ".." })).rejects.toThrow("outside");

		const inTree = await tools.get("safe_git")!.execute("call", { subcommand: "rev-parse", args: ["--is-inside-work-tree"] }) as unknown as { content: Array<{ text: string }>; details: { exitCode: number } };
		expect(inTree.content[0]?.text.trim()).toBe("true");
		expect(inTree.details.exitCode).toBe(0);
		const failed = await tools.get("safe_git")!.execute("call", { subcommand: "rev-parse", args: ["--verify", "definitely-missing-ref"] }) as unknown as { details: { exitCode: number } };
		expect(failed.details.exitCode).not.toBe(0);
		await expect(tools.get("safe_git")!.execute("call", { subcommand: "diff", args: ["--output=/tmp/leak"] })).rejects.toThrow("not allowed");
	});
});
