import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSIONS = fileURLToPath(new URL("../../", import.meta.url));
/** The daemon's whole module graph: a change to any of it makes a running daemon another build. */
const SOURCES = ["runtime/service", "runtime/schemas", "runtime/errors.ts", "shared/worktree.ts", "shared/config.ts"];

function files(path: string): string[] {
	return statSync(path).isDirectory() ? readdirSync(path).sort().flatMap((name) => files(join(path, name))) : [path];
}

/** A hash of the daemon source on disk now; a session hashes at each check, so one not reloaded since an update matches the new daemon. */
export function runtimeBuild(): string {
	const hash = createHash("sha256");
	for (const file of SOURCES.flatMap((source) => files(join(EXTENSIONS, source)))) hash.update(file.slice(EXTENSIONS.length)).update(readFileSync(file));
	return hash.digest("hex").slice(0, 16);
}

export const RUNTIME_BUILD = runtimeBuild();
