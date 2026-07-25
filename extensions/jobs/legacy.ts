import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export function legacyProcessStateFiles(home = homedir()): string[] {
	const directory = path.join(home, ".pi", "agent", "process-state");
	if (!existsSync(directory)) return [];
	return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => path.join(directory, name));
}
