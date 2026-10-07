import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const FILE = "pi-kit.json";
const Flag = Type.Optional(Type.Boolean());
const Text = Type.Optional(Type.String());
const KEYS = {
	models: Type.Record(Type.String(), Type.String()),
	lead: Type.Union([Type.String(), Type.Null()]),
	autonomy: Type.Boolean(),
	guard: Type.Object({ detached: Flag, forcePush: Flag, rmRf: Flag, block: Type.Optional(Type.Array(Type.String())) }),
	codexFast: Type.Boolean(),
	notifier: Type.Object({
		enabled: Flag, title: Text, body: Text, terminal: Flag, bell: Flag, terminalRequiresTty: Flag,
		command: Type.Optional(Type.Array(Type.String())), jsonl: Text, minIntervalMs: Type.Optional(Type.Number()),
	}),
};
const KitFile = Type.Partial(Type.Object(KEYS));
const JsonObject = Type.Object({});
const AnyKit = Type.Record(Type.String(), Type.Unknown());
/** `autonomy` was `"auto" | "ask"` before it became a boolean; read as such until migrateLegacyConfig rewrites it. */
const LegacyAutonomy = Type.Union([Type.Literal("auto"), Type.Literal("ask")]);

export type KitKey = keyof typeof KEYS;
export type KitValue<K extends KitKey> = Static<(typeof KEYS)[K]>;
type Kit = Static<typeof KitFile>;

/** Pi's `getAgentDir()` without importing Pi, so the standalone guard hook can read pi-kit.json too. */
export function agentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR;
	return dir ? dir.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".pi", "agent");
}

/** The global, then the project pi-kit.json; every reader takes them fresh, so an edit applies to the next use. */
function kitPaths(cwd: string, dir = agentDir()): [global: string, project: string] {
	return [join(dir, FILE), join(cwd, ".pi", FILE)];
}

/**
 * `key` from the global and the project pi-kit.json, re-read on every call. A file that does not parse counts as absent, and a value off
 * its schema keeps only its valid fields; each problem is warned about once, so a typo never silently drops the rest of the file.
 */
export function kitValues<K extends KitKey>(key: K, cwd: string, dir = agentDir()): [global: KitValue<K> | undefined, project: KitValue<K> | undefined] {
	const [global, project] = kitPaths(cwd, dir).map((path) => readKitKey(path, key));
	return [global, project];
}

/** `key` from a trusted project's pi-kit.json, else from the global one. */
export function trustedKitValue<K extends KitKey>(key: K, ctx: { cwd: string; isProjectTrusted(): boolean }): KitValue<K> | undefined {
	const [global, project] = kitValues(key, ctx.cwd);
	return (ctx.isProjectTrusted() ? project : undefined) ?? global;
}

function readKitKey<K extends KitKey>(path: string, key: K): KitValue<K> | undefined {
	let file;
	try { file = parseFile(path, AnyKit); } catch (error) {
		warnOnce(error instanceof Error ? error.message : String(error));
		return undefined;
	}
	const raw = file?.[key];
	const value = key === "autonomy" && Value.Check(LegacyAutonomy, raw) ? raw === "auto" : raw;
	if (value === undefined) return undefined;
	if (Value.Check(KEYS[key], value)) return value;
	const [first] = Value.Errors(KEYS[key], value);
	warnOnce(`${path}: /${key}${first?.instancePath ?? ""} ${first?.message}`);
	if (!Value.Check(JsonObject, value)) return undefined;
	// SAFETY: every field of an object key is optional, so the fields that check alone make a valid KitValue<K>.
	return Object.fromEntries(Object.entries(value).filter(([field, item]) => Value.Check(KEYS[key], { [field]: item }))) as KitValue<K>;
}

const WARNED = Symbol.for("pi-kit.config-warnings");
// SAFETY: this package exclusively owns the symbol-keyed slot and only ever stores the set in it.
const warned = ((globalThis as typeof globalThis & { [WARNED]?: Set<string> })[WARNED] ??= new Set());

function warnOnce(problem: string): void {
	if (warned.has(problem)) return;
	warned.add(problem);
	console.warn(`pi-kit: ${problem}; using the defaults for what is invalid.`);
}

/**
 * Moves each legacy `.pi/<file>` of a trusted project into `.pi/pi-kit.json` once and deletes it; keys already set there win.
 * A pi-kit.json that does not parse, or a notifier.json off the schema, is left for the user.
 */
export async function migrateLegacyConfig(cwd: string): Promise<void> {
	await upgradeAutonomy(cwd);
	await moveLegacy(cwd, "runtime.json", Type.Object({ auto: Type.Literal(true) }), () => ({ autonomy: true }), { autonomy: false });
	await moveLegacy(cwd, "codex-fast.json", Type.Object({ enabled: Flag }), (file) => ({ codexFast: file.enabled }), {});
	await moveLegacy(cwd, "notifier.json", KEYS.notifier, (notifier) => ({ notifier }), undefined);
	await moveLegacy(cwd, "subagents.json", Type.Object({ defaultModel: Text }), (file) => ({ models: file.defaultModel === undefined ? undefined : { default: file.defaultModel } }), {});
}

async function upgradeAutonomy(cwd: string): Promise<void> {
	const [global, project] = kitPaths(cwd);
	for (const path of [global, project]) {
		let file;
		try { file = parseFile(path, AnyKit); } catch { continue; }
		const legacy = file?.autonomy;
		if (!file || !Value.Check(LegacyAutonomy, legacy)) continue;
		const next = { ...file, autonomy: legacy === "auto" };
		if (path === project) await saveProjectKit(cwd, next);
		else writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	}
}

async function moveLegacy<T extends TSchema>(cwd: string, name: string, schema: T, convert: (file: Static<T>) => Kit, invalid: Kit | undefined): Promise<void> {
	const legacyPath = join(cwd, ".pi", name);
	let moved: Kit | undefined;
	try {
		const file = parseFile(legacyPath, schema);
		if (file === undefined) return;
		moved = convert(file);
	} catch {
		moved = invalid;
	}
	if (!moved) return;
	let kit: Kit;
	try { kit = parseFile(kitPaths(cwd)[1], KitFile) ?? {}; } catch { return; }
	const next: Kit = { ...moved, ...kit };
	if (moved.models && kit.models) next.models = { ...moved.models, ...kit.models };
	if (moved.notifier && kit.notifier) next.notifier = { ...moved.notifier, ...kit.notifier };
	await saveProjectKit(cwd, next);
	rmSync(legacyPath, { force: true });
}

/** Writes `.pi/pi-kit.json` through a temp file; a symlinked `.pi` or `pi-kit.json` is refused, never followed. */
async function saveProjectKit(cwd: string, kit: Kit): Promise<void> {
	const dir = join(cwd, ".pi");
	const path = join(dir, FILE);
	for (const target of [dir, path]) {
		if ((await lstat(target).catch(() => undefined))?.isSymbolicLink()) throw new Error(`Refusing to write project config through the symlink ${target}`);
	}
	await mkdir(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(kit, null, 2)}\n`);
	await rename(tmp, path);
}

/** A JSON file checked against `schema`: undefined when it does not exist; throws `<path>: <pointer> <message>` otherwise. */
function parseFile<T extends TSchema>(path: string, schema: T): Static<T> | undefined {
	let text: string;
	try { text = readFileSync(path, "utf8"); } catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let value;
	try { value = JSON.parse(text); } catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (Value.Check(schema, value)) return value;
	const [first] = Value.Errors(schema, value);
	throw new Error(`${path}: ${first?.instancePath || "/"} ${first?.message}`);
}
