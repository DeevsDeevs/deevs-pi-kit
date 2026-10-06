import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { saveProjectConfig } from "./project-config.ts";

const KIT_FILE = "pi-kit.json";
const KitFile = Type.Object({ autonomy: Type.Optional(Type.String()) });
const LegacyRuntimeFile = Type.Object({ auto: Type.Literal(true) });

/**
 * `"autonomy": "auto" | "ask"` in pi-kit.json, re-read on every use: a trusted project's `.pi/pi-kit.json` overrides `~/.pi/agent/pi-kit.json`.
 * Absent everywhere means auto; any other value, or a file that does not parse, means ask.
 */
export async function isAutonomous(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<boolean> {
	if (ctx.isProjectTrusted()) {
		await migrateRuntimeAuto(ctx.cwd);
		const project = await readAutonomy(join(ctx.cwd, ".pi", KIT_FILE));
		if (project !== undefined) return project;
	}
	return await readAutonomy(join(getAgentDir(), KIT_FILE)) ?? true;
}

async function readAutonomy(file: string): Promise<boolean | undefined> {
	const kit = await readChecked(file, KitFile);
	if (kit === "missing") return undefined;
	if (kit === "invalid") return false;
	return kit.autonomy === undefined ? undefined : kit.autonomy === "auto";
}

/** One-time move of `/runtime auto on`'s `.pi/runtime.json` into `.pi/pi-kit.json`; a pi-kit.json that does not parse is left for the user. */
async function migrateRuntimeAuto(cwd: string): Promise<void> {
	const legacyPath = join(cwd, ".pi", "runtime.json");
	const legacy = await readChecked(legacyPath, LegacyRuntimeFile);
	if (legacy === "missing") return;
	const kit = await readChecked(join(cwd, ".pi", KIT_FILE), KitFile);
	if (kit === "invalid") return;
	const current = kit === "missing" ? {} : kit;
	if (current.autonomy === undefined) await saveProjectConfig(cwd, KIT_FILE, { ...current, autonomy: legacy === "invalid" ? "ask" : "auto" });
	await rm(legacyPath, { force: true });
}

async function readChecked<T extends TSchema>(file: string, schema: T): Promise<Static<T> | "missing" | "invalid"> {
	let raw: string;
	try { raw = await readFile(file, "utf8"); } catch { return "missing"; }
	let value: unknown;
	try { value = JSON.parse(raw); } catch { return "invalid"; }
	return Value.Check(schema, value) ? value : "invalid";
}
