import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { acceptsKnownPiBraceAdvisory } from "./audit-policy.mjs";

const result = spawnSync("npm", ["audit", "--json", "--audit-level=high"], { encoding: "utf8" });
if (result.error) throw result.error;

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr || result.stdout || "npm audit produced no report\n");
	process.exit(1);
}

const vulnerabilities = Object.values(report.vulnerabilities ?? {});
if (!vulnerabilities.length) {
	console.log("Supply-chain audit: no vulnerabilities found.");
	process.exit(0);
}

// pi-coding-agent 0.82.x publishes an npm-shrinkwrap that pins brace-expansion 5.0.7,
// so root overrides cannot select fixed 5.0.8. Keep this exception exact and expiring.
let installedVersion = "missing";
try {
	installedVersion = JSON.parse(readFileSync(resolve("node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json"), "utf8")).version;
} catch { /* missing or malformed package fails the policy below */ }

if (acceptsKnownPiBraceAdvisory(vulnerabilities, installedVersion)) {
	console.warn("Supply-chain audit: temporarily accepting GHSA-mh99-v99m-4gvg in pi-coding-agent's published dev-only shrinkwrap; fixed brace-expansion 5.0.8 cannot be overridden downstream. Exception expires 2026-08-15.");
	process.exit(0);
}

process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(1);
