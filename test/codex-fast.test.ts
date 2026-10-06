import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codexFastExtension from "../extensions/codex-fast/index.ts";

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "codex-fast-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ codexFast: true }));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function inject(model: { provider: string; api: string; id: string }, payload: unknown, oauth = true, trusted = true): unknown {
	let beforeRequest: ((event: { payload: unknown }, ctx: ExtensionContext) => unknown) | undefined;
	const pi = {
		on(name: string, handler: unknown) { if (name === "before_provider_request") beforeRequest = handler as typeof beforeRequest; },
	} as unknown as ExtensionAPI;
	codexFastExtension(pi);
	const ctx = {
		cwd,
		hasUI: false,
		isProjectTrusted: () => trusted,
		model,
		modelRegistry: { isUsingOAuth: () => oauth },
	} as unknown as ExtensionContext;
	return beforeRequest!({ payload }, ctx);
}

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.0-codex" };

describe("codex fast", () => {
	it("applies priority tier to future OpenAI Codex OAuth models without a version allowlist", () => {
		expect(inject(codex, { model: "gpt-6.0-codex", input: [] })).toEqual({ model: "gpt-6.0-codex", input: [], service_tier: "priority" });
	});

	it("follows pi-kit.json on every request and ignores an untrusted project's value", () => {
		expect(inject(codex, { model: "gpt-6.0-codex" }, true, false)).toBeUndefined();
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ codexFast: false }));
		expect(inject(codex, { model: "gpt-6.0-codex" })).toBeUndefined();
	});

	it.each([
		["other provider", { provider: "openai", api: "openai-responses", id: "gpt-6.0" }, { model: "gpt-6.0" }, true],
		["wrong API", { provider: "openai-codex", api: "openai-responses", id: "gpt-6.0-codex" }, { model: "gpt-6.0-codex" }, true],
		["API-key auth", codex, { model: "gpt-6.0-codex" }, false],
		["payload model mismatch", codex, { model: "other" }, true],
		["existing tier", codex, { model: "gpt-6.0-codex", service_tier: "flex" }, true],
		["non-object payload", codex, [], true],
	] as const)("does not override %s", (_label, model, payload, oauth) => {
		expect(inject(model, payload, oauth)).toBeUndefined();
	});
});
