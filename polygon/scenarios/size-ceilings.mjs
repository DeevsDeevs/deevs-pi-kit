import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Production lines (.ts, .mjs, .js) per area of the kit under test stay within polygon/ceilings.json. A step that adds code
// raises its area by the step's stated lines in the same commit; a step that deletes code lowers it.
const SKIP = new Set(["node_modules", "results", "private"]);
const lines = (path) => {
	if (!existsSync(path)) return 0;
	if (statSync(path).isDirectory()) return readdirSync(path).filter((name) => !SKIP.has(name)).reduce((sum, name) => sum + lines(join(path, name)), 0);
	return /\.(ts|mjs|js)$/.test(path) ? readFileSync(path, "utf8").split("\n").length - 1 : 0;
};

export default {
	name: "size-ceilings",
	gate: ["M0", "M2", "M6"],
	async run(t) {
		const ceilings = JSON.parse(readFileSync(new URL("../ceilings.json", import.meta.url), "utf8"));
		const areas = Object.entries(ceilings).map(([area, { paths, max }]) => ({ area, max, lines: paths.reduce((sum, path) => sum + lines(join(t.kit, path)), 0) }));
		assert.ok(areas.find((a) => a.area === "kit").lines > 0, "counted no kit code");
		assert.deepEqual(areas.filter((a) => a.lines > a.max), [], "areas over their ceiling");
	},
};
