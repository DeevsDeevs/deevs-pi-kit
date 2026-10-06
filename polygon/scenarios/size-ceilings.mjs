import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Production .ts/.mjs lines per area stay within polygon/ceilings.json (§6); tests are not counted.
const lines = (path) => {
	if (!existsSync(path)) return 0;
	if (statSync(path).isFile()) return /\.(ts|mjs)$/.test(path) ? readFileSync(path, "utf8").split("\n").length - 1 : 0;
	return readdirSync(path).filter((name) => name !== "node_modules").reduce((sum, name) => sum + lines(join(path, name)), 0);
};

export default {
	name: "size-ceilings",
	gate: ["M0", "M2", "M6"],
	async run(t) {
		const ceilings = JSON.parse(readFileSync(join(t.kit, "polygon", "ceilings.json"), "utf8"));
		const over = Object.entries(ceilings)
			.map(([area, { paths, max }]) => ({ area, max, count: paths.reduce((sum, path) => sum + lines(join(t.kit, path)), 0) }))
			.filter(({ count, max }) => count > max);
		assert.deepEqual(over, [], over.map(({ area, count, max }) => `${area}: ${count} lines over its ceiling of ${max}`).join("; "));
	},
};
