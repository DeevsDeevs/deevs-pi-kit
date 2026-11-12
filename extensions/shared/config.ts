import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const FILE = "pi-kit.json";
const KEYS = {
	codexFast: Type.Boolean(),
};
const AnyKit = Type.Record(Type.String(), Type.Unknown());

export type KitKey = keyof typeof KEYS;
export type KitValue<K extends KitKey> = Static<(typeof KEYS)[K]>;
export type Trust = { cwd: string; isProjectTrusted(): boolean };

/** Pi's `getAgentDir()` without importing Pi. */
export function agentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR;
	return dir ? dir.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".pi", "agent");
}

/** The global, then the project pi-kit.json; every reader takes them fresh, so an edit applies to the next use. */
function kitPaths(cwd: string, dir = agentDir()): [global: string, project: string] {
	return [join(dir, FILE), join(cwd, ".pi", FILE)];
}

/**
 * `key` from the global and the project pi-kit.json, re-read on every call. A file that does not parse, or a value off its schema,
 * counts as absent; each problem is warned about once, naming the file and the key.
 */
export function kitValues<K extends KitKey>(key: K, cwd: string, dir = agentDir()): [global: KitValue<K> | undefined, project: KitValue<K> | undefined] {
	const [global, project] = kitPaths(cwd, dir).map((path) => readKitKey(path, key));
	return [global, project];
}

/** `key` like kitValues, with the project's value dropped until Pi trusts the project. */
export function trustedKitValues<K extends KitKey>(key: K, ctx: Trust, dir = agentDir()): [global: KitValue<K> | undefined, project: KitValue<K> | undefined] {
	const [global, project] = kitValues(key, ctx.cwd, dir);
	return [global, ctx.isProjectTrusted() ? project : undefined];
}

function readKitKey<K extends KitKey>(path: string, key: K): KitValue<K> | undefined {
	let file;
	try { file = parseFile(path, AnyKit); } catch (error) {
		warnOnce(error instanceof Error ? error.message : String(error));
		return undefined;
	}
	const value = file?.[key];
	if (value === undefined) return undefined;
	if (Value.Check(KEYS[key], value)) return value;
	const [first] = Value.Errors(KEYS[key], value);
	warnOnce(`${path}: /${key}${first?.instancePath ?? ""} ${first?.message}`);
	return undefined;
}

const WARNED = Symbol.for("pi-kit.config-warnings");
// SAFETY: this package exclusively owns the symbol-keyed slot and only ever stores the set in it.
const warned = ((globalThis as typeof globalThis & { [WARNED]?: Set<string> })[WARNED] ??= new Set());

function warnOnce(problem: string): void {
	if (warned.has(problem)) return;
	warned.add(problem);
	console.warn(`pi-kit: ${problem}; using the defaults for what is invalid.`);
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
