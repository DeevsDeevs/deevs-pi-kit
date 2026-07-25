import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export function legacyProcessStateFiles(home = homedir()): string[] {
	const directory = path.join(home, ".pi", "agent", "process-state");
	if (!existsSync(directory)) return [];
	return readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => path.join(directory, name)).filter((file) => {
		try {
			const raw = readFileSync(file, "utf8");
			if (!raw.trim()) return false;
			const state = JSON.parse(raw) as { version?: unknown; processes?: unknown };
			return state.version !== 1 || !Array.isArray(state.processes) || state.processes.length > 0;
		} catch {
			return true;
		}
	});
}
