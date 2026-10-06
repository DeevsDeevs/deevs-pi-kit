import { spawnSync } from "node:child_process";

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

process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(1);
