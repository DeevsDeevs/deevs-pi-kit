import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codexFastExtension from "../extensions/codex-fast/index.ts";

async function inject(model: { provider: string; api: string; id: string }, payload: unknown, oauth = true): Promise<unknown> {
	let beforeRequest: ((event: { payload: unknown }, ctx: ExtensionContext) => unknown) | undefined;
	let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> } | undefined;
	const pi = {
		on(name: string, handler: unknown) { if (name === "before_provider_request") beforeRequest = handler as typeof beforeRequest; },
		registerCommand(_name: string, value: unknown) { command = value as typeof command; },
	} as unknown as ExtensionAPI;
	codexFastExtension(pi);
	const ctx = {
		cwd: "/tmp",
		hasUI: false,
		sessionManager: {},
		model,
		modelRegistry: { isUsingOAuth: () => oauth },
		ui: { setStatus() {}, notify() {} },
	} as unknown as ExtensionContext;
	await command!.handler("on", ctx);
	return beforeRequest!({ payload }, ctx);
}

describe("codex fast", () => {
	it("applies priority tier to future OpenAI Codex OAuth models without a version allowlist", async () => {
		expect(await inject(
			{ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.0-codex" },
			{ model: "gpt-6.0-codex", input: [] },
		)).toEqual({ model: "gpt-6.0-codex", input: [], service_tier: "priority" });
	});

	it.each([
		["other provider", { provider: "openai", api: "openai-responses", id: "gpt-6.0" }, { model: "gpt-6.0" }, true],
		["wrong API", { provider: "openai-codex", api: "openai-responses", id: "gpt-6.0-codex" }, { model: "gpt-6.0-codex" }, true],
		["API-key auth", { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.0-codex" }, { model: "gpt-6.0-codex" }, false],
		["payload model mismatch", { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.0-codex" }, { model: "other" }, true],
		["existing tier", { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.0-codex" }, { model: "gpt-6.0-codex", service_tier: "flex" }, true],
		["non-object payload", { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.0-codex" }, [], true],
	] as const)("does not override %s", async (_label, model, payload, oauth) => {
		expect(await inject(model, payload, oauth)).toBeUndefined();
	});
});
