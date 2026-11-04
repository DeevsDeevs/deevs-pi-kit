import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { KIT_DEFAULTS, loadKitConfig, modelLabel, modelsTable, newest, resolveLead, resolveModel, type KitConfig, type ModelCatalog, type ModelContext } from "../extensions/shared/models.ts";

const ALL_LEVELS: ThinkingLevelMap = { xhigh: "xhigh", max: "max" };

function model(provider: string, id: string, thinkingLevelMap: ThinkingLevelMap = ALL_LEVELS): Model<Api> {
	// SAFETY: the resolver reads only provider, id, reasoning and thinkingLevelMap.
	return { provider, id, reasoning: true, thinkingLevelMap } as Model<Api>;
}

// Pi's openai-codex catalog as of 2026-10-06, in its order.
const CODEX = [
	model("openai-codex", "gpt-6.1-sol", { off: null, xhigh: "xhigh", max: "max" }),
	model("openai-codex", "gpt-6-astra"),
	model("openai-codex", "gpt-6-sol"),
	model("openai-codex", "gpt-6-luna"),
	model("openai-codex", "gpt-5.3-codex-spark"),
	model("openai-codex", "gpt-5.5", { xhigh: "xhigh" }),
	model("openai-codex", "gpt-5.6-luna"),
	model("openai-codex", "gpt-5.6-sol"),
	model("openai-codex", "gpt-5.6-terra"),
];
const OPUS_LEVELS: ThinkingLevelMap = { off: null, minimal: null, xhigh: "xhigh", max: "max" };
const ANTHROPIC = [
	"claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-4-5-20251001",
	"claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
	"claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5",
].map((id) => model("anthropic", id, id.startsWith("claude-haiku") ? {} : id === "claude-opus-5-5" ? OPUS_LEVELS : ALL_LEVELS));
const BEDROCK = [model("amazon-bedrock", "anthropic.claude-opus-5"), model("amazon-bedrock", "gpt-6.1-sol")];
// Pi 1.0.4 signs in with ChatGPT under `openai`.
const OPENAI = [model("openai", "gpt-6.1-sol"), model("openai", "gpt-6-astra"), model("openai", "gpt-4o")];
const CATALOG = [...CODEX, ...ANTHROPIC, ...BEDROCK, ...OPENAI];

function byId(id: string): Model<Api> {
	const found = CATALOG.find((entry) => entry.id === id);
	if (!found) throw new Error(`no fixture ${id}`);
	return found;
}

/** `oauth`: the providers signed in through Pi's OAuth; the rest of `loggedIn` hold an API key. */
function registry(loggedIn: string[], all = CATALOG, oauth = loggedIn): ModelCatalog {
	const available = all.filter((entry) => loggedIn.includes(entry.provider));
	return {
		getAll: () => all,
		getAvailable: () => available,
		find: (provider, id) => all.find((entry) => entry.provider === provider && entry.id === id),
		isUsingOAuth: (entry) => oauth.includes(entry.provider),
	};
}

const LEAD = { model: byId("gpt-6.1-sol"), level: "high" as const };

function context(overrides: Partial<ModelContext> = {}): ModelContext {
	return { config: KIT_DEFAULTS, registry: registry(["openai-codex"]), lead: LEAD, ...overrides };
}

function label(spec: string | undefined, ctx = context()): string {
	return modelLabel(resolveModel(spec, ctx));
}

function failure(spec: string | undefined, ctx = context()): string {
	try {
		resolveModel(spec, ctx);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error(`${spec} resolved`);
}

describe("newest", () => {
	it("picks the highest version numerically, not lexically", () => {
		expect(newest("gpt-*-sol", ["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.10-sol", "gpt-6.2-sol"])).toBe("gpt-6.10-sol");
		expect(newest("gpt-*-sol", CODEX.map((entry) => entry.id))).toBe("gpt-6.1-sol");
		expect(newest("gpt-*-astra", CODEX.map((entry) => entry.id))).toBe("gpt-6-astra");
		expect(newest("gpt-*-luna", CODEX.map((entry) => entry.id))).toBe("gpt-6-luna");
		expect(newest("claude-opus-*", ANTHROPIC.map((entry) => entry.id))).toBe("claude-opus-5-5");
		expect(newest("claude-fable-*", ANTHROPIC.map((entry) => entry.id))).toBe("claude-fable-5-1");
	});

	it("drops the date suffix and prefers the undated twin", () => {
		expect(newest("claude-haiku-*", ["claude-haiku-4-5-20251001", "claude-haiku-4-5"])).toBe("claude-haiku-4-5");
		expect(newest("claude-haiku-*", ["claude-haiku-4-5", "claude-haiku-4-5-20251001"])).toBe("claude-haiku-4-5");
		expect(newest("claude-sonnet-*", ["claude-sonnet-4-5-20250929"])).toBe("claude-sonnet-4-5-20250929");
		expect(newest("gpt-*-sol", ["gpt-6.1-sol-20261001", "gpt-6-sol"])).toBe("gpt-6.1-sol-20261001");
	});

	it("lets * stand for a version only", () => {
		expect(newest("gpt-*-sol", ["gpt-6-codex-sol", "gpt-6.1-sol-mini", "gpt-sol"])).toBeUndefined();
		expect(newest("gpt-*", ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"])).toBe("gpt-5.5");
		expect(newest("gpt-6.1-sol", ["gpt-6.1-sol"])).toBe("gpt-6.1-sol");
		expect(newest("gpt-6.1+sol", ["gpt-6.1+sol", "gpt-6.1-sol"])).toBe("gpt-6.1+sol");
		expect(newest("gpt.*-sol", ["gptx6-sol"])).toBeUndefined();
	});
});

describe("resolveModel", () => {
	it("resolves the kit defaults on today's catalogs", () => {
		expect(label("sol")).toBe("openai-codex/gpt-6.1-sol:high");
		expect(label("astra")).toBe("openai-codex/gpt-6-astra:high");
		expect(label("luna")).toBe("openai-codex/gpt-6-luna:high");
		expect(label("terra")).toBe("openai-codex/gpt-5.6-terra:high");
		expect(resolveModel("astra", context())).toMatchObject({ model: { provider: "openai-codex", id: "gpt-6-astra" }, level: "high" });
	});

	it("prefers the openai ChatGPT login and falls back to legacy openai-codex per name", () => {
		const both = context({ registry: registry(["openai", "openai-codex"]) });
		expect(label("sol", both)).toBe("openai/gpt-6.1-sol:high");
		expect(label("astra:max", both)).toBe("openai/gpt-6-astra:max");
		expect(label("terra", both)).toBe("openai-codex/gpt-5.6-terra:high");
		expect(label("sol", context({ registry: registry(["openai"]) }))).toBe("openai/gpt-6.1-sol:high");
		expect(failure("terra", context({ registry: registry(["openai"]) }))).toContain("terra → openai/gpt-*-terra|openai-codex/gpt-*-terra: no logged-in openai model matches gpt-*-terra; openai-codex is not logged in.");
	});

	it("runs a built-in name on a Pi OAuth login before an API key; an explicit provider/id or your own a|b keeps its order", () => {
		const keyAndCodexLogin = context({ registry: registry(["openai", "openai-codex"], CATALOG, ["openai-codex"]) });
		expect(label("astra", keyAndCodexLogin)).toBe("openai-codex/gpt-6-astra:high");
		expect(label("sol:max", keyAndCodexLogin)).toBe("openai-codex/gpt-6.1-sol:max");
		expect(label("openai/gpt-*-astra", keyAndCodexLogin)).toBe("openai/gpt-6-astra:high");
		expect(label("astra", context({ registry: registry(["openai", "openai-codex"], CATALOG, []) }))).toBe("openai/gpt-6-astra:high");
		const config: KitConfig = { ...KIT_DEFAULTS, models: { ...KIT_DEFAULTS.models, deep: "astra", mine: KIT_DEFAULTS.models.astra } };
		expect(label("deep", { ...keyAndCodexLogin, config })).toBe("openai-codex/gpt-6-astra:high");
		expect(label("mine", { ...keyAndCodexLogin, config })).toBe("openai/gpt-6-astra:high");
		expect(modelsTable({ ...keyAndCodexLogin, config: { ...KIT_DEFAULTS, models: { astra: KIT_DEFAULTS.models.astra } } })).toEqual(["astra → openai-codex/gpt-6-astra:high"]);
	});

	it("inherits the lead's model and level by default", () => {
		const lead = { model: byId("gpt-5.6-sol"), level: "max" as const };
		expect(label(undefined, context({ lead }))).toBe("openai-codex/gpt-5.6-sol:max");
		expect(label("inherit:low", context({ lead }))).toBe("openai-codex/gpt-5.6-sol:low");
		expect(failure(undefined, context({ lead: undefined }))).toContain('Model "default" did not resolve: default → inherit: there is no lead model to inherit.');
	});

	it("lets the outermost level win and leaves the level unset without a lead", () => {
		const config: KitConfig = { ...KIT_DEFAULTS, models: { ...KIT_DEFAULTS.models, deep: "astra:max", cheap: "openai-codex/gpt-*-luna:medium" } };
		expect(label("deep", context({ config }))).toBe("openai-codex/gpt-6-astra:max");
		expect(label("deep:low", context({ config }))).toBe("openai-codex/gpt-6-astra:low");
		expect(label("cheap", context({ config }))).toBe("openai-codex/gpt-6-luna:medium");
		expect(label("sol:xhigh")).toBe("openai-codex/gpt-6.1-sol:xhigh");
		expect(resolveModel("sol", context({ lead: undefined }))).toMatchObject({ level: undefined });
	});

	it("lets a Workflow effort beat every level in the spec, clamped", () => {
		const config: KitConfig = { ...KIT_DEFAULTS, models: { ...KIT_DEFAULTS.models, deep: "astra:max" } };
		expect(modelLabel(resolveModel("deep:high", context({ config }), "low"))).toBe("openai-codex/gpt-6-astra:low");
		expect(modelLabel(resolveModel(undefined, context(), "off"))).toBe("openai-codex/gpt-6.1-sol:minimal (off is not supported)");
	});

	it("clamps a level to what the model supports and says so", () => {
		expect(label("openai-codex/gpt-5.5:max")).toBe("openai-codex/gpt-5.5:xhigh (max is not supported)");
		expect(label("sol:off")).toBe("openai-codex/gpt-6.1-sol:minimal (off is not supported)");
		expect(resolveModel("openai-codex/gpt-5.5:max", context())).toMatchObject({ level: "xhigh", clampedFrom: "max" });
	});

	it("rejects a level Pi does not have", () => {
		for (const spec of ["sol:ultra", "openai-codex/gpt-6.1-sol:ultra"]) {
			expect(failure(spec)).toContain("ultra is not a level; the levels are off, minimal, low, medium, high, xhigh, max.");
		}
	});

	it("takes exact provider ids only from logged-in providers", () => {
		expect(label("openai-codex/gpt-6.1-sol:max")).toBe("openai-codex/gpt-6.1-sol:max");
		expect(failure("openai-codex/gpt-7-sol")).toContain("openai-codex/gpt-7-sol: openai-codex/gpt-7-sol is not in Pi's catalog.");
		expect(failure("openai-codex/gpt-*-mars")).toContain("no logged-in openai-codex model matches gpt-*-mars.");
		expect(failure("anthropic/claude-opus-5-5")).toContain("anthropic is not logged in.");
		expect(failure("openai/gpt-5.4")).toContain("openai is not logged in.");
		expect(failure("mistral/large")).toContain("mistral is not a Pi provider.");
		expect(label("anthropic/claude-opus-*", context({ registry: registry(["openai-codex", "anthropic"]) }))).toBe("anthropic/claude-opus-5-5:high");
	});

	it("accepts a bare id only when one logged-in model has it", () => {
		expect(label("gpt-6.1-sol:max")).toBe("openai-codex/gpt-6.1-sol:max");
		const both = context({ registry: registry(["openai-codex", "amazon-bedrock"]) });
		expect(failure("gpt-6.1-sol", both)).toContain("gpt-6.1-sol is logged in under several providers: openai-codex/gpt-6.1-sol, amazon-bedrock/gpt-6.1-sol.");
		expect(failure("opsu")).toContain("opsu: opsu is not a configured name or a logged-in model id.");
	});

	it("lists every spec tried, the names, the logged-in models and the catalog hint", () => {
		const config: KitConfig = { ...KIT_DEFAULTS, models: { ...KIT_DEFAULTS.models, deep: "astra:max", astra: "openai-codex/gpt-*-astrra" } };
		const message = failure("deep", context({ config }));
		expect(message).toContain('Model "deep" did not resolve: deep → astra:max → openai-codex/gpt-*-astrra: no logged-in openai-codex model matches gpt-*-astrra.');
		expect(message).toContain("Names: default → inherit, sol → openai/gpt-*-sol|openai-codex/gpt-*-sol,");
		expect(message).toContain("deep → astra:max.");
		expect(message).toContain("Logged-in models: openai-codex/gpt-6.1-sol, openai-codex/gpt-6-astra,");
		expect(message).toContain("openai-codex/gpt-5.6-terra.");
		expect(message).toContain("run `pi update --models`, or add it to Pi's models.json.");
		expect(failure("sol", context({ registry: registry([]) }))).toContain("Logged-in models: none, log in with /login.");
	});

	it("stops on names that refer to each other", () => {
		const config: KitConfig = { ...KIT_DEFAULTS, models: { ...KIT_DEFAULTS.models, a: "b", b: "a:high" } };
		expect(failure("a", context({ config }))).toContain('Model "a" did not resolve: a → b → a:high: these names refer to each other in a loop.');
	});
});

describe("modelsTable", () => {
	it("shows what each name runs now, and names that do not resolve", () => {
		const config: KitConfig = { ...KIT_DEFAULTS, models: { default: "inherit", astra: "openai-codex/gpt-*-astra", gone: "openai/gpt-9" } };
		expect(modelsTable(context({ config }))).toEqual([
			"default → openai-codex/gpt-6.1-sol:high",
			"astra → openai-codex/gpt-6-astra:high",
			"gone → openai/gpt-9 (does not resolve now)",
		]);
	});
});

describe("resolveLead", () => {
	it("switches to the newest sol at Pi's level unless the spec has one", () => {
		expect(resolveLead(context())).toMatchObject({ model: { id: "gpt-6.1-sol" }, level: undefined });
		expect(resolveLead(context({ config: { ...KIT_DEFAULTS, lead: "sol:xhigh" } }))).toMatchObject({ model: { id: "gpt-6.1-sol" }, level: "xhigh" });
		expect(resolveLead(context({ config: { ...KIT_DEFAULTS, lead: null } }))).toBeUndefined();
		expect(() => resolveLead(context({ registry: registry([]) }))).toThrow("openai-codex is not logged in");
		const unset = { models: KIT_DEFAULTS.models };
		expect(resolveLead(context({ config: unset }))).toMatchObject({ model: { id: "gpt-6.1-sol" } });
		expect(resolveLead(context({ config: unset, registry: registry([]) }))).toBeUndefined();
	});

	it("takes the built-in default only through a Pi OAuth login, never an API key; a lead or sol you set may bill a key without one", () => {
		const unset = { models: KIT_DEFAULTS.models };
		const keyAndCodexLogin = registry(["openai", "openai-codex"], CATALOG, ["openai-codex"]);
		expect(resolveLead(context({ config: unset, registry: keyAndCodexLogin }))).toMatchObject({ model: { provider: "openai-codex", id: "gpt-6.1-sol" } });
		expect(resolveLead(context({ config: unset, registry: registry(["openai"], CATALOG, []) }))).toBeUndefined();
		expect(resolveLead(context({ config: unset, registry: registry(["openai"]) }))).toMatchObject({ model: { provider: "openai", id: "gpt-6.1-sol" } });
		expect(resolveLead(context({ config: { ...unset, lead: "sol" }, registry: keyAndCodexLogin }))).toMatchObject({ model: { provider: "openai-codex" } });
		expect(resolveLead(context({ config: { ...unset, lead: "sol" }, registry: registry(["openai"], CATALOG, []) }))).toMatchObject({ model: { provider: "openai" } });
		expect(resolveLead(context({ config: { models: { ...unset.models, sol: "openai/gpt-*-sol" } }, registry: keyAndCodexLogin }))).toMatchObject({ model: { provider: "openai" } });
	});
});

describe("loadKitConfig", () => {
	function dirs(): { cwd: string; agentDir: string } {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-models-"));
		mkdirSync(join(root, "agent"));
		mkdirSync(join(root, "project", ".pi"), { recursive: true });
		return { cwd: join(root, "project"), agentDir: join(root, "agent") };
	}

	it("returns the kit defaults without files", async () => {
		const { cwd, agentDir } = dirs();
		expect(await loadKitConfig({ cwd, isProjectTrusted: () => true }, agentDir)).toEqual({ models: KIT_DEFAULTS.models });
	});

	it("merges per name, project over global over defaults, and rereads on every load", async () => {
		const { cwd, agentDir } = dirs();
		writeFileSync(join(agentDir, "pi-kit.json"), JSON.stringify({ models: { deep: "astra:max", sol: "openai-codex/gpt-5.6-sol" }, lead: "astra", autonomy: true }));
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ models: { deep: "openai-codex/gpt-*-sol:xhigh" } }));
		const config = await loadKitConfig({ cwd, isProjectTrusted: () => true }, agentDir);
		expect(config.models).toEqual({ ...KIT_DEFAULTS.models, sol: "openai-codex/gpt-5.6-sol", deep: "openai-codex/gpt-*-sol:xhigh" });
		expect(config.lead).toBe("astra");
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ models: { deep: "luna" }, lead: null }));
		const edited = await loadKitConfig({ cwd, isProjectTrusted: () => true }, agentDir);
		expect(edited.models.deep).toBe("luna");
		expect(edited.lead).toBeNull();
		expect(KIT_DEFAULTS.models).not.toHaveProperty("deep");
	});

	it("ignores an untrusted project's names and lead", async () => {
		const { cwd, agentDir } = dirs();
		writeFileSync(join(agentDir, "pi-kit.json"), JSON.stringify({ models: { deep: "luna" } }));
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ models: { default: "luna", deep: "astra" }, lead: null }));
		expect(await loadKitConfig({ cwd, isProjectTrusted: () => false }, agentDir)).toEqual({ models: { ...KIT_DEFAULTS.models, deep: "luna" } });
	});

	it("keeps the valid names over the defaults and warns with the file and the field that is wrong", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { cwd, agentDir } = dirs();
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ models: { opus: ["anthropic/claude-opus-*"], deep: "luna" } }));
		writeFileSync(join(agentDir, "pi-kit.json"), "{ nope");
		expect(await loadKitConfig({ cwd, isProjectTrusted: () => true }, agentDir)).toEqual({ models: { ...KIT_DEFAULTS.models, deep: "luna" } });
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${join(cwd, ".pi", "pi-kit.json")}: /models/opus must be string`));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(agentDir, "pi-kit.json")));
		warn.mockRestore();
	});
});

