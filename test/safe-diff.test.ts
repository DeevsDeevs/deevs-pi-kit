import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSafeDiffTool } from "../extensions/shared/safe-diff.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("safe_diff", () => {
	it("reads exact commits without invoking configured external diff commands", async () => {
		const root = repository();
		const sentinel = join(root, "external-diff-ran");
		writeFileSync(join(root, ".gitattributes"), "*.txt diff=unsafe\n");
		writeFileSync(join(root, "file.txt"), "base\n");
		git(root, "add", ".");
		git(root, "commit", "-qm", "base");
		const base = git(root, "rev-parse", "HEAD").trim();
		git(root, "config", "diff.unsafe.command", `touch ${sentinel}`);
		writeFileSync(join(root, "file.txt"), "changed\n");
		git(root, "commit", "-qam", "changed");
		const head = git(root, "rev-parse", "HEAD").trim();
		const tool = registeredTool();
		const result = await tool.execute("call", { base, head, paths: ["file.txt"], contextLines: 1 }, undefined, undefined, { cwd: root });
		expect(result.content[0]?.text).toContain("-base");
		expect(result.content[0]?.text).toContain("+changed");
		expect(result.details).toMatchObject({ root, baseCommit: base, headCommit: head, paths: ["file.txt"], truncated: false });
		expect(existsSync(sentinel)).toBe(false);
	});

	it("ignores replacement refs while reporting exact commit IDs", async () => {
		const root = repository();
		writeFileSync(join(root, "file.txt"), "base\n");
		git(root, "add", ".");
		git(root, "commit", "-qm", "base");
		const base = git(root, "rev-parse", "HEAD").trim();
		writeFileSync(join(root, "file.txt"), "changed\n");
		git(root, "commit", "-qam", "changed");
		const head = git(root, "rev-parse", "HEAD").trim();
		git(root, "replace", base, head);
		const result = await registeredTool().execute("call", { base, head, paths: ["file.txt"] }, undefined, undefined, { cwd: root });
		expect(result.content[0]?.text).toContain("-base");
		expect(result.content[0]?.text).toContain("+changed");
		expect(result.details).toMatchObject({ baseCommit: base, headCommit: head });
	});

	it("fails on missing promisor objects without invoking a remote helper", async () => {
		const parent = mkdtempSync(join(tmpdir(), "safe-diff-promisor-"));
		roots.push(parent);
		const source = join(parent, "source");
		mkdirSync(source);
		git(source, "init", "-q");
		git(source, "config", "user.name", "Test");
		git(source, "config", "user.email", "test@example.com");
		git(source, "config", "uploadpack.allowFilter", "true");
		writeFileSync(join(source, "file.txt"), "base\n");
		git(source, "add", ".");
		git(source, "commit", "-qm", "base");
		const base = git(source, "rev-parse", "HEAD").trim();
		writeFileSync(join(source, "file.txt"), "changed\n");
		git(source, "commit", "-qam", "changed");
		const head = git(source, "rev-parse", "HEAD").trim();
		const clone = join(parent, "clone");
		execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${source}`, clone]);
		git(clone, "config", "remote.origin.url", "sentinel::missing");
		const bin = join(parent, "bin");
		mkdirSync(bin);
		const helper = join(bin, "git-remote-sentinel");
		const sentinel = join(parent, "lazy-fetch-ran");
		writeFileSync(helper, `#!/bin/sh\ntouch "$SAFE_DIFF_SENTINEL"\nexit 1\n`);
		chmodSync(helper, 0o755);
		const previousPath = process.env.PATH;
		const previousSentinel = process.env.SAFE_DIFF_SENTINEL;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.SAFE_DIFF_SENTINEL = sentinel;
		try {
			await expect(registeredTool().execute("call", { base, head }, undefined, undefined, { cwd: clone })).rejects.toThrow("Git operation failed");
			expect(existsSync(sentinel)).toBe(false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
			if (previousSentinel === undefined) delete process.env.SAFE_DIFF_SENTINEL; else process.env.SAFE_DIFF_SENTINEL = previousSentinel;
		}
	});

	it("kills output beyond its process buffer cap", async () => {
		const root = repository();
		writeFileSync(join(root, "large.txt"), "a\n");
		git(root, "add", ".");
		git(root, "commit", "-qm", "base");
		const base = git(root, "rev-parse", "HEAD").trim();
		writeFileSync(join(root, "large.txt"), Array.from({ length: 10_000 }, (_, index) => `changed-${index}`).join("\n"));
		git(root, "commit", "-qam", "large");
		const head = git(root, "rev-parse", "HEAD").trim();
		await expect(registeredTool().execute("call", { base, head }, undefined, undefined, { cwd: root })).rejects.toThrow("Git operation failed");
	});

	it("rejects revision option injection, path escape, and non-root cwd", async () => {
		const root = repository();
		writeFileSync(join(root, "file.txt"), "base\n");
		git(root, "add", ".");
		git(root, "commit", "-qm", "base");
		const head = git(root, "rev-parse", "HEAD").trim();
		const tool = registeredTool();
		await expect(tool.execute("call", { base: "--output=owned", head }, undefined, undefined, { cwd: root })).rejects.toThrow("unsupported syntax");
		await expect(tool.execute("call", { base: head, head, paths: ["../outside"] }, undefined, undefined, { cwd: root })).rejects.toThrow("escapes");
		mkdirSync(join(root, "nested"));
		await expect(tool.execute("call", { base: head, head }, undefined, undefined, { cwd: join(root, "nested") })).rejects.toThrow("worktree root");
	});
});

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "safe-diff-"));
	roots.push(root);
	git(root, "init", "-q");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.com");
	return root;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function registeredTool(): { execute: (...args: any[]) => Promise<any> } {
	let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
	registerSafeDiffTool({ registerTool(value: typeof tool) { tool = value; } } as unknown as ExtensionAPI);
	return tool!;
}
