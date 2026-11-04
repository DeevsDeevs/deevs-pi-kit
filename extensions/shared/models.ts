import { clampThinkingLevel, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { trustedKitValues, type Trust } from "./config.ts";

export type ModelCatalog = Pick<ModelRegistry, "getAll" | "getAvailable" | "find" | "isUsingOAuth">;
export type KitConfig = { models: Record<string, string>; lead?: string | null };

export interface ModelContext {
	config: KitConfig;
	registry: ModelCatalog;
	/** The lead's live model and level: `inherit` takes both, and a Pi spec without a level takes the level. */
	lead?: { model: Model<Api>; level: ModelThinkingLevel };
	/** Only Pi OAuth (ChatGPT) logins resolve: the built-in lead never moves a session onto API billing, as `OPENAI_API_KEY` would. */
	oauthOnly?: boolean;
}

type Leveled = { level?: ModelThinkingLevel; clampedFrom?: ModelThinkingLevel };
export type ResolvedModel = { model: Model<Api> } & Leveled;
type Miss = { reason: string };

export const KIT_DEFAULTS = {
	models: {
		default: "inherit",
		sol: "openai/gpt-*-sol|openai-codex/gpt-*-sol",
		astra: "openai/gpt-*-astra|openai-codex/gpt-*-astra",
		luna: "openai/gpt-*-luna|openai-codex/gpt-*-luna",
		terra: "openai/gpt-*-terra|openai-codex/gpt-*-terra",
	},
	lead: "sol",
} satisfies KitConfig;

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
const DATED = /-\d{8}$/;
const BUILT_IN: Record<string, string> = KIT_DEFAULTS.models;

/** What a resolution takes, built fresh for each one so an edit to pi-kit.json applies to the next call. */
export async function modelContext(ctx: Trust & { modelRegistry: ModelCatalog }, lead?: ModelContext["lead"]): Promise<ModelContext> {
	return { config: await loadKitConfig(ctx), registry: ctx.modelRegistry, lead };
}

/** A trusted project over global over kit defaults, per name; an untrusted project could point every Agent at a model of its choosing. */
export async function loadKitConfig(ctx: Trust, dir?: string): Promise<KitConfig> {
	const leads = trustedKitValues("lead", ctx, dir);
	return {
		models: Object.assign({}, KIT_DEFAULTS.models, ...trustedKitValues("models", ctx, dir)),
		lead: leads.reduce<string | null | undefined>((lead, file) => (file === undefined ? lead : file), undefined),
	};
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

/** Resolves an explicit model, a persona's model, or (when both are absent) `default`; `effort` beats any level in the spec, and `a|b` takes the first alternative that resolves, for a built-in name the first on a Pi OAuth (ChatGPT) login, so `OPENAI_API_KEY` bills only without one. Throws before anything starts. */
export function resolveModel(spec: string | undefined, ctx: ModelContext, effort?: ModelThinkingLevel): ResolvedModel {
	const tried: string[] = [];
	const names = new Set<string>();
	let current = spec ?? "default";
	let level = effort;
	let builtIn = false;
	for (;;) {
		tried.push(current);
		const [body, own] = splitLevel(current);
		level ??= own;
		if (body !== "inherit" && Object.hasOwn(ctx.config.models, body)) {
			if (names.has(body)) throw resolutionError(tried, "these names refer to each other in a loop", ctx);
			names.add(body);
			current = ctx.config.models[body];
			builtIn = current === BUILT_IN[body];
			continue;
		}
		const outcomes = body.split("|").map((alternative) => resolveSpec(alternative, level, ctx));
		const resolved = outcomes.filter((outcome): outcome is ResolvedModel => !("reason" in outcome));
		const chosen = (builtIn && resolved.length > 1 && resolved.find((r) => ctx.registry.isUsingOAuth(r.model))) || resolved[0];
		if (chosen) return chosen;
		throw resolutionError(tried, badLevel(current) ?? outcomes.flatMap((outcome) => ("reason" in outcome ? [outcome.reason] : [])).join("; "), ctx);
	}
}

/** The `lead` key for a new session; `undefined` when it is `null`, or unset and the default does not resolve. The level stays Pi's setting unless the spec carries one. */
export function resolveLead(ctx: ModelContext): ResolvedModel | undefined {
	if (ctx.config.lead === undefined) {
		const oauthOnly = ctx.config.models.sol === KIT_DEFAULTS.models.sol;
		try { return resolveLead({ ...ctx, oauthOnly, config: { ...ctx.config, lead: KIT_DEFAULTS.lead } }); } catch { return undefined; }
	}
	if (ctx.config.lead === null) return undefined;
	return resolveModel(ctx.config.lead, { ...ctx, lead: undefined });
}

/** What ran, for launch results: `openai-codex/gpt-6-astra:high`. */
export function modelLabel(resolved: ResolvedModel): string {
	const target = ref(resolved.model);
	const label = resolved.level ? `${target}:${resolved.level}` : target;
	return resolved.clampedFrom ? `${label} (${resolved.clampedFrom} is not supported)` : label;
}

/** One line per configured name with what it resolves to now; the models view of `/agents`. */
export function modelsTable(ctx: ModelContext): string[] {
	return Object.entries(ctx.config.models).map(([name, spec]) => {
		try {
			return `${name} → ${modelLabel(resolveModel(name, ctx))}`;
		} catch {
			return `${name} → ${spec} (does not resolve now)`;
		}
	});
}

function resolveSpec(body: string, level: ModelThinkingLevel | undefined, ctx: ModelContext): ResolvedModel | Miss {
	const { registry, lead } = ctx;
	if (body === "inherit") return lead ? pi(lead.model, level ?? lead.level) : { reason: "there is no lead model to inherit" };
	const slash = body.indexOf("/");
	if (slash > 0) {
		const provider = body.slice(0, slash);
		const id = body.slice(slash + 1);
		const available = loggedIn(ctx).filter((model) => model.provider === provider);
		if (!available.length) return { reason: registry.getAll().some((model) => model.provider === provider) ? `${provider} is not logged in` : `${provider} is not a Pi provider` };
		const chosen = newest(id, available.map((model) => model.id));
		const found = available.find((model) => model.id === chosen);
		if (found) return pi(found, level ?? lead?.level);
		return { reason: id.includes("*") ? `no logged-in ${provider} model matches ${id}` : `${body} is not in Pi's catalog` };
	}
	const matches = loggedIn(ctx).filter((model) => model.id === body);
	if (matches.length === 1) return pi(matches[0], level ?? lead?.level);
	if (matches.length > 1) return { reason: `${body} is logged in under several providers: ${matches.map(ref).join(", ")}` };
	return { reason: `${body} is not a configured name or a logged-in model id` };
}

const loggedIn = ({ registry, oauthOnly }: ModelContext): Model<Api>[] => registry.getAvailable().filter((model) => !oauthOnly || registry.isUsingOAuth(model));

function pi(model: Model<Api>, level: ModelThinkingLevel | undefined): ResolvedModel {
	return { model, ...clamp(model, level) };
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
	const word = /:([a-z]+)$/.exec(spec)?.[1];
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
