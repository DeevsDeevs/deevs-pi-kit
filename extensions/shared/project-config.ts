import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type ConfigNormalizer<T> = (input: Partial<T>) => T;

export function projectConfigPath(cwd: string, filename: string): string {
	if (!/^[A-Za-z0-9_.-]+\.json$/.test(filename)) throw new Error(`Invalid project config filename: ${filename}`);
	return resolve(cwd, ".pi", filename);
}

export function assertInsideProjectConfig(cwd: string, path: string): void {
	const root = resolve(cwd, ".pi");
	const rel = relative(root, resolve(path));
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Project config path escapes .pi/: ${path}`);
}

export async function readProjectConfig<T extends object>(cwd: string, filename: string): Promise<Partial<T>> {
	const path = projectConfigPath(cwd, filename);
	try {
		await ensureSafeProjectConfigTarget(cwd, path, false);
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Partial<T> : {};
	} catch {
		return {};
	}
}

export async function loadProjectConfig<T extends object>(cwd: string, filename: string, defaults: T, normalize: ConfigNormalizer<T>, override: Partial<T> = {}): Promise<T> {
	return normalize({ ...structuredClone(defaults), ...await readProjectConfig<T>(cwd, filename), ...override } as Partial<T>);
}

export async function saveProjectConfig<T extends object>(cwd: string, filename: string, config: T): Promise<string> {
	const path = projectConfigPath(cwd, filename);
	await ensureSafeProjectConfigTarget(cwd, path, true);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(stripUndefined(config), null, 2)}\n`, "utf8");
	await rename(tmp, path);
	return path;
}

async function ensureSafeProjectConfigTarget(cwd: string, path: string, rejectExistingTargetSymlink: boolean): Promise<void> {
	assertInsideProjectConfig(cwd, path);
	const cwdReal = await realpath(cwd).catch(() => resolve(cwd));
	const piDir = resolve(cwd, ".pi");
	try {
		const piStat = await lstat(piDir);
		if (piStat.isSymbolicLink()) throw new Error(`Refusing to use symlinked project config directory: ${piDir}`);
		const piReal = await realpath(piDir);
		const rel = relative(cwdReal, piReal);
		if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Project config directory escapes cwd: ${piDir}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!rejectExistingTargetSymlink) return;
	try {
		const targetStat = await lstat(path);
		if (targetStat.isSymbolicLink()) throw new Error(`Refusing to overwrite symlinked project config file: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function stripUndefined<T extends object>(value: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function mergeDeep<T extends object>(base: T, patch: unknown): T {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(base);
	const output: Record<string, unknown> = structuredClone(base) as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const current = output[key];
		if (current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)) {
			output[key] = mergeDeep(current as Record<string, unknown>, value);
		} else {
			output[key] = value;
		}
	}
	return output as T;
}
