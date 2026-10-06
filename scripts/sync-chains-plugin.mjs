// Copies the Pi-free Chains core into the Claude Code / Codex plugin, which installers copy without the rest of the repo.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAINS_PLUGIN_CORE = ["chains/service.ts", "chains/parser.ts", "chains/types.ts", "chains/format.ts", "shared/terms.ts", "shared/bytes.ts"];

for (const file of CHAINS_PLUGIN_CORE) {
	const target = join(root, "plugins/chains/lib", file);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(join(root, "extensions", file), target);
}
console.log(`Synced ${CHAINS_PLUGIN_CORE.length} files into plugins/chains/lib.`);
