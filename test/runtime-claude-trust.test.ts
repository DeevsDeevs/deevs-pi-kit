import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedClaude } from "../extensions/runtime/claude-trust.ts";

function config(projects: Record<string, { hasTrustDialogAccepted?: boolean }>): string {
	const path = join(mkdtempSync(join(tmpdir(), "claude-trust-")), ".claude.json");
	writeFileSync(path, JSON.stringify({ theme: "dark", projects }));
	return path;
}

it("a worktree inherits the trust its repository already has", () => {
	const path = config({ "/repo": { hasTrustDialogAccepted: true } });
	expect(seedClaude("/wt", "/repo", path)).toBe(true);
	const written = JSON.parse(readFileSync(path, "utf8"));
	expect(written).toMatchObject({ theme: "dark", bypassPermissionsModeAccepted: true, projects: { "/repo": { hasTrustDialogAccepted: true }, "/wt": { hasTrustDialogAccepted: true } } });
});

it("an untrusted repository is left for Claude Code to ask about; the bypass acceptance is seeded once", () => {
	const path = config({ "/repo": { hasTrustDialogAccepted: false } });
	expect(seedClaude("/wt", "/repo", path)).toBe(false);
	const seeded = readFileSync(path, "utf8");
	expect(JSON.parse(seeded)).toMatchObject({ bypassPermissionsModeAccepted: true, projects: { "/repo": { hasTrustDialogAccepted: false } } });
	expect(JSON.parse(seeded).projects["/wt"]).toBeUndefined();
	expect(seedClaude("/wt", "/elsewhere", path)).toBe(false);
	expect(readFileSync(path, "utf8")).toBe(seeded);
});
