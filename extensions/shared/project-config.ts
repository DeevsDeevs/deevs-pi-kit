import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

type ConfigNormalizer<T> = (input: Partial<T>) => T;

function projectConfigPath(cwd: string, filename: string): string {
	if (!/^[A-Za-z0-9_.-]+\.json$/.test(filename)) throw new Error(`Invalid project config filename: ${filename}`);
	return resolve(cwd, ".pi", filename);
}

function assertInsideProjectConfig(cwd: string, path: string): void {
	const root = resolve(cwd, ".pi");
	const rel = relative(root, resolve(path));
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Project config path escapes .pi/: ${path}`);
}

async function readProjectConfig<T extends object>(cwd: string, filename: string): Promise<Partial<T>> {
	const path = projectConfigPath(cwd, filename);
	try {
		await ensureSafeProjectConfigTarget(cwd, path, false);
		// SAFETY: Converting JSON.parse's `any` to `unknown` prevents use before the shape check below.
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		// SAFETY: This private reader exposes only an untrusted property bag to the caller-supplied normalizer; no field is consumed before normalization.
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Partial<T> : {};
	} catch {
		return {};
	}
}

export async function loadProjectConfig<T extends object>(cwd: string, filename: string, defaults: T, normalize: ConfigNormalizer<T>, override: Partial<T> = {}): Promise<T> {
	return normalize({ ...structuredClone(defaults), ...await readProjectConfig<T>(cwd, filename), ...override });
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
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (!rejectExistingTargetSymlink) return;
	try {
		const targetStat = await lstat(path);
		if (targetStat.isSymbolicLink()) throw new Error(`Refusing to overwrite symlinked project config file: ${path}`);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

function stripUndefined<T extends object>(value: T): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
