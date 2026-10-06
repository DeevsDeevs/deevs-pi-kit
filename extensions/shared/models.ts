import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { kitValues } from "./config.ts";

export type ModelCatalog = Pick<ModelRegistry, "getAll" | "getAvailable" | "find">;
export type KitConfig = { models: Record<string, string>; lead: string | null };
export type CodexCatalog = { slugs: string[]; model?: string };

export interface ModelContext {
	config: KitConfig;
	registry: ModelCatalog;
	/** The lead's live model and level: `inherit` takes both, and a Pi spec without a level takes the level. */
	lead?: { model: Model<Api>; level: ModelThinkingLevel };
	codex?: CodexCatalog;
}

type Leveled = { level?: ModelThinkingLevel; clampedFrom?: ModelThinkingLevel };
export type ResolvedModel =
	| ({ harness: "pi"; model: Model<Api> } & Leveled)
	| ({ harness: "claude" | "codex"; model: string } & Leveled);
type Miss = { reason: string };

export const KIT_DEFAULTS = {
	models: {
		default: "inherit",
		sol: "openai-codex/gpt-*-sol",
		astra: "openai-codex/gpt-*-astra",
		luna: "openai-codex/gpt-*-luna",
		terra: "openai-codex/gpt-*-terra",
		opus: "claude:opus",
		sonnet: "claude:sonnet",
		haiku: "claude:haiku",
		fable: "claude:fable",
	},
	lead: "sol",
} satisfies KitConfig;

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
const DATED = /-\d{8}$/;
const CodexCache = Type.Object({ models: Type.Array(Type.Object({ slug: Type.String() })) });

/** Project over global over kit defaults, per name. Callers load it again for every resolution, so an edit applies to the next call. */
export async function loadKitConfig(cwd: string, agentDir: string): Promise<KitConfig> {
	const leads = kitValues("lead", cwd, agentDir);
	return {
		models: Object.assign({}, KIT_DEFAULTS.models, ...kitValues("models", cwd, agentDir)),
		lead: leads.reduce<string | null>((lead, file) => (file === undefined ? lead : file), KIT_DEFAULTS.lead),
	};
}

/** Codex's model cache and the top-level `model` of its config.toml; either may be missing. */
export function readCodexCatalog(codexHome: string): CodexCatalog {
	let cache;
	try {
		cache = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8"));
	} catch {}
	let toml = "";
	try {
		toml = readFileSync(join(codexHome, "config.toml"), "utf8");
	} catch {}
	const model = /^model\s*=\s*["']([^"'\n]+)["']/m.exec(toml.split(/^\s*\[/m)[0])?.[1];
	return { slugs: Value.Check(CodexCache, cache) ? cache.models.map((entry) => entry.slug) : [], model };
}

/** `*` stands for a version only; the highest version wins numerically, and an undated id beats its `-YYYYMMDD` twin. */
export function newest(pattern: string, ids: readonly string[]): string | undefined {
	const star = pattern.indexOf("*");
	if (star < 0) return ids.find((id) => id === pattern);
	const version = new RegExp(`^${escapeRegExp(pattern.slice(0, star))}(\\d+(?:[.-]\\d+)*)${escapeRegExp(pattern.slice(star + 1))}$`);
	let best: { id: string; key: number[]; dated: boolean } | undefined;
	for (const id of ids) {
		const base = id.replace(DATED, "");
		const match = version.exec(base)?.[1];
		if (match === undefined) continue;
		const candidate = { id, key: match.split(/[.-]/).map(Number), dated: base !== id };
		if (!best || compareVersions(candidate, best) > 0) best = candidate;
	}
	return best?.id;
}

function compareVersions(a: { key: number[]; dated: boolean }, b: { key: number[]; dated: boolean }): number {
	for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
		const diff = (a.key[i] ?? -1) - (b.key[i] ?? -1);
		if (diff) return diff;
	}
	return Number(b.dated) - Number(a.dated);
}

/** Resolves an explicit model, a persona's model, or (when both are absent) `default`; `effort` beats any level in the spec. Throws before anything starts. */
export function resolveModel(spec: string | undefined, ctx: ModelContext, effort?: ModelThinkingLevel): ResolvedModel {
	const tried: string[] = [];
	const names = new Set<string>();
	let current = spec ?? "default";
	let level = effort;
	for (;;) {
		tried.push(current);
		const [body, own] = splitLevel(current);
		level ??= own;
		if (body !== "inherit" && Object.hasOwn(ctx.config.models, body)) {
			if (names.has(body)) throw resolutionError(tried, "these names refer to each other in a loop", ctx);
			names.add(body);
			current = ctx.config.models[body];
			continue;
		}
		const outcome = resolveSpec(current, body, level, ctx);
		if ("reason" in outcome) throw resolutionError(tried, badLevel(current) ?? outcome.reason, ctx);
		return outcome;
	}
}

/** The `lead` key for a new session; `undefined` when it is `null`. The level stays Pi's setting unless the spec carries one. */
export function resolveLead(ctx: ModelContext): Extract<ResolvedModel, { harness: "pi" }> | undefined {
	if (ctx.config.lead === null) return undefined;
	const resolved = resolveModel(ctx.config.lead, { ...ctx, lead: undefined });
	if (resolved.harness === "pi") return resolved;
	throw new Error(`The lead must be a Pi model, but "${ctx.config.lead}" is ${modelLabel(resolved)}.`);
}

/** What ran, for launch results: `openai-codex/gpt-6-astra:high`, `claude:opus`. */
export function modelLabel(resolved: ResolvedModel): string {
	const target = resolved.harness === "pi" ? ref(resolved.model) : `${resolved.harness}:${resolved.model}`;
	const label = resolved.level ? `${target}:${resolved.level}` : target;
	return resolved.clampedFrom ? `${label} (${resolved.clampedFrom} is not supported)` : label;
}

function resolveSpec(spec: string, body: string, level: ModelThinkingLevel | undefined, ctx: ModelContext): ResolvedModel | Miss {
	const { registry, lead } = ctx;
	if (body === "inherit") return lead ? pi(lead.model, level ?? lead.level) : { reason: "there is no lead model to inherit" };
	if (spec.startsWith("claude:")) return claude(body.slice(7), level, registry);
	if (spec.startsWith("codex:")) return codex(body.slice(6), level, ctx);
	const slash = body.indexOf("/");
	if (slash > 0) {
		const provider = body.slice(0, slash);
		const id = body.slice(slash + 1);
		const available = registry.getAvailable().filter((model) => model.provider === provider);
		if (!available.length) return { reason: registry.getAll().some((model) => model.provider === provider) ? `${provider} is not logged in` : `${provider} is not a Pi provider` };
		const chosen = newest(id, available.map((model) => model.id));
		const found = available.find((model) => model.id === chosen);
		if (found) return pi(found, level ?? lead?.level);
		return { reason: id.includes("*") ? `no logged-in ${provider} model matches ${id}` : `${body} is not in Pi's catalog` };
	}
	const matches = registry.getAvailable().filter((model) => model.id === body);
	if (matches.length === 1) return pi(matches[0], level ?? lead?.level);
	if (matches.length > 1) return { reason: `${body} is logged in under several providers: ${matches.map(ref).join(", ")}` };
	return { reason: `${body} is not a configured name or a logged-in model id` };
}

function pi(model: Model<Api>, level: ModelThinkingLevel | undefined): ResolvedModel {
	return { harness: "pi", model, ...clamp(model, level) };
}

/** CC's `--effort` has no `off` or `minimal`: `off` leaves CC's default and `minimal` becomes `low`. */
function claude(name: string, level: ModelThinkingLevel | undefined, registry: ModelCatalog): ResolvedModel | Miss {
	const ids = registry.getAll().filter((model) => model.provider === "anthropic").map((model) => model.id);
	const family = name.replace(/\[1m\]$/, "");
	const id = ids.includes(family) ? family : newest(`claude-${family}-*`, ids);
	if (!id) {
		const families = [...new Set(ids.flatMap((known) => /^claude-([a-z]+)-\d/.exec(known)?.[1] ?? []))];
		return { reason: `Claude Code takes ${families.join(", ")} or a claude-* id from Pi's catalog` };
	}
	const clamped = clamp(registry.find("anthropic", id), level).level;
	const effort = clamped === "off" ? undefined : clamped === "minimal" ? "low" : clamped;
	return { harness: "claude", model: name, level: effort, clampedFrom: effort === level ? undefined : level };
}

/** A slug from Pi's `openai-codex` catalog, Codex's cache or its config.toml; no slug takes the lead's id on `openai-codex`, else config.toml's. */
function codex(slug: string, level: ModelThinkingLevel | undefined, ctx: ModelContext): ResolvedModel | Miss {
	const piIds = ctx.registry.getAll().filter((model) => model.provider === "openai-codex").map((model) => model.id);
	const known = [...new Set([...piIds, ...(ctx.codex?.slugs ?? []), ...(ctx.codex?.model ? [ctx.codex.model] : [])])];
	const leadId = ctx.lead?.model.provider === "openai-codex" ? ctx.lead.model.id : undefined;
	const chosen = slug ? newest(slug, known) : (leadId ?? ctx.codex?.model);
	if (!chosen) return { reason: slug ? `Codex knows ${known.join(", ")}` : "the lead is not on openai-codex and ~/.codex/config.toml names no model" };
	return { harness: "codex", model: chosen, ...clamp(ctx.registry.find("openai-codex", chosen), level) };
}

function clamp(model: Model<Api> | undefined, level: ModelThinkingLevel | undefined): Leveled {
	if (!model || !level) return { level };
	const clamped = clampThinkingLevel(model, level);
	return clamped === level ? { level } : { level: clamped, clampedFrom: level };
}

function splitLevel(spec: string): [string, ModelThinkingLevel | undefined] {
	const colon = spec.lastIndexOf(":");
	const level = colon > 0 ? LEVELS.find((known) => known === spec.slice(colon + 1)) : undefined;
	return level ? [spec.slice(0, colon), level] : [spec, undefined];
}

function badLevel(spec: string): string | undefined {
	const word = /:([a-z]+)$/.exec(spec.replace(/^(claude|codex):/, ""))?.[1];
	return word && !LEVELS.some((known) => known === word) ? `${word} is not a level; the levels are ${LEVELS.join(", ")}` : undefined;
}

function resolutionError(tried: string[], reason: string, ctx: ModelContext): Error {
	const names = Object.entries(ctx.config.models).map(([name, spec]) => `${name} → ${spec}`);
	const loggedIn = ctx.registry.getAvailable().map(ref);
	return new Error([
		`Model "${tried[0]}" did not resolve: ${tried.join(" → ")}: ${reason}.`,
		`Names: ${names.join(", ")}.`,
		`Logged-in models: ${loggedIn.join(", ") || "none, log in with /login"}.`,
		"A model missing from Pi's catalog: run `pi update --models`, or add it to Pi's models.json.",
	].join("\n"));
}

function ref(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
