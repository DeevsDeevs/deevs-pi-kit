import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inheritClaudeTrust } from "../extensions/runtime/claude-trust.ts";
import { assertKnownCodexModel } from "../extensions/runtime/collaborator-policy.ts";

function config(projects: Record<string, { hasTrustDialogAccepted?: boolean }>): string {
	const path = join(mkdtempSync(join(tmpdir(), "claude-trust-")), ".claude.json");
	writeFileSync(path, JSON.stringify({ theme: "dark", projects }));
	return path;
}

it("a worktree inherits the trust its repository already has", () => {
	const path = config({ "/repo": { hasTrustDialogAccepted: true } });
	expect(inheritClaudeTrust("/wt", "/repo", path)).toBe(true);
	const written = JSON.parse(readFileSync(path, "utf8"));
	expect(written).toMatchObject({ theme: "dark", projects: { "/repo": { hasTrustDialogAccepted: true }, "/wt": { hasTrustDialogAccepted: true } } });
});

it("an untrusted repository is left for Claude Code to ask about", () => {
	const path = config({ "/repo": { hasTrustDialogAccepted: false } });
	const before = readFileSync(path, "utf8");
	expect(inheritClaudeTrust("/wt", "/repo", path)).toBe(false);
	expect(inheritClaudeTrust("/wt", "/elsewhere", path)).toBe(false);
	expect(readFileSync(path, "utf8")).toBe(before);
	expect(inheritClaudeTrust("/wt", "/repo", join(tmpdir(), "absent-claude.json"))).toBe(false);
});

it("a Codex model is checked against the CLI's own catalog cache", () => {
	const home = mkdtempSync(join(tmpdir(), "codex-models-"));
	writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }, { slug: "gpt-5.6-terra" }] }));
	expect(() => assertKnownCodexModel("gpt-6-astra", [], home)).not.toThrow();
	expect(() => assertKnownCodexModel("astra", [], home)).toThrow("Unknown Codex model astra; Codex knows gpt-6-astra, gpt-5.6-terra.");
	expect(() => assertKnownCodexModel("astra", [], join(tmpdir(), "absent-codex-home"))).not.toThrow();
});

it("a stale Codex cache still accepts the configured default and Pi's openai-codex catalog", () => {
	const home = mkdtempSync(join(tmpdir(), "codex-models-"));
	writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
	writeFileSync(join(home, "config.toml"), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "gpt-6-luna"\n');
	expect(() => assertKnownCodexModel("gpt-6.1-sol", [], home)).not.toThrow();
	expect(() => assertKnownCodexModel("gpt-6-luna", [], home)).toThrow("Codex knows gpt-6-astra, gpt-6.1-sol.");
	expect(() => assertKnownCodexModel("gpt-6-terra", ["gpt-6-terra"], home)).not.toThrow();
});
