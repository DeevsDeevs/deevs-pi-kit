import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedClaude } from "../extensions/runtime/claude-trust.ts";

function configPath(): string {
	return join(mkdtempSync(join(tmpdir(), "claude-trust-")), ".claude.json");
}

function config(projects: Record<string, { hasTrustDialogAccepted?: boolean }>, extra: object = {}): string {
	const path = configPath();
	writeFileSync(path, JSON.stringify({ theme: "dark", ...extra, projects }));
	return path;
}

it("a worktree inherits the trust its repository already has", () => {
	const path = config({ "/repo": { hasTrustDialogAccepted: true } });
	seedClaude("/wt", "/repo", path);
	const written = JSON.parse(readFileSync(path, "utf8"));
	expect(written).toMatchObject({ theme: "dark", bypassPermissionsModeAccepted: true, projects: { "/repo": { hasTrustDialogAccepted: true }, "/wt": { hasTrustDialogAccepted: true } } });
});

it("an untrusted repository is left for Claude Code to ask about; the bypass acceptance is seeded once", () => {
	const path = config({ "/repo": { hasTrustDialogAccepted: false } });
	seedClaude("/wt", "/repo", path);
	const seeded = readFileSync(path, "utf8");
	expect(JSON.parse(seeded)).toMatchObject({ bypassPermissionsModeAccepted: true, projects: { "/repo": { hasTrustDialogAccepted: false } } });
	expect(JSON.parse(seeded).projects["/wt"]).toBeUndefined();
	seedClaude("/wt", "/elsewhere", path);
	expect(readFileSync(path, "utf8")).toBe(seeded);
});

it("a truncated config is never replaced", () => {
	const path = configPath();
	const truncated = '{"oauthAccount":{"emailAddress":"user@example.com"},"projects":{"/repo":{"hasTrust';
	writeFileSync(path, truncated);
	seedClaude("/wt", "/repo", path);
	expect(readFileSync(path, "utf8")).toBe(truncated);
});

it("a config that already holds every seed is not rewritten", () => {
	const path = config({ "/repo": { hasTrustDialogAccepted: true }, "/wt": { hasTrustDialogAccepted: true } }, { bypassPermissionsModeAccepted: true });
	const before = statSync(path);
	seedClaude("/wt", "/repo", path);
	expect(statSync(path).ino).toBe(before.ino);
	expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
});

it("a missing config is created with the bypass acceptance only", () => {
	const path = configPath();
	seedClaude("/wt", "/repo", path);
	expect(existsSync(path)).toBe(true);
	expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ bypassPermissionsModeAccepted: true });
});
