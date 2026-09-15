import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./harness.mjs";

const scripts = ["burst", "inbox-race", "caps", "restart", "fanout"];

const runs = await Promise.all(scripts.map(async (name) => {
	const child = spawn(process.execPath, ["--experimental-strip-types", join(repo, "bench/protocol", `${name}.mjs`)], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
	const [code] = await once(child, "exit");
	let result = { name, ok: false, metrics: {}, failures: [`no result file; exit ${code}: ${stderr}`] };
	try { result = JSON.parse(readFileSync(join(repo, "bench/results/protocol", `${name}.json`), "utf8")); } catch {}
	return { ...result, exitCode: code };
}));

const rows = runs.map((run) => [run.name, run.ok ? "ok" : "FAIL", String(run.metrics.durationSec ?? "-"), headline(run)]);
const header = ["bench", "result", "sec", "headline"];
const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
const line = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
process.stdout.write(`\n${line(header)}\n${widths.map((width) => "-".repeat(width)).join("  ")}\n`);
for (const row of rows) process.stdout.write(`${line(row)}\n`);
for (const run of runs) for (const failure of run.failures) process.stdout.write(`\nFAILED ${run.name}: ${failure}\n`);
process.exitCode = runs.every((run) => run.ok) ? 0 : 1;

function headline(run) {
	const metrics = run.metrics;
	switch (run.name) {
		case "burst": return `${metrics.sends} sends, ${metrics.sendsPerSec}/s, ack p50/p95/p99 ${percentileText(metrics.ackLatencyMs)} ms, state ${kib(metrics.stateBytesBefore)}→${kib(metrics.stateBytesAfter)}, rss ${kib(metrics.rssBytesAfter)}`;
		case "inbox-race": return `${metrics.distinctDelivered}/${metrics.messages} delivered, ${metrics.duplicates} duplicates, inbox p50/p95/p99 ${percentileText(metrics.inboxLatencyMs)} ms in ${metrics.totalSec}s`;
		case "caps": return `body ${metrics.oversizedBody?.code}, line ${metrics.oversizedRequest?.code}, inbox pages ${metrics.oversizedResponse?.pages?.join("/")} (${metrics.oversizedResponse?.mailLost} lost), state cap at ${metrics.stateCap?.messages} near-max bodies, records ${metrics.recordCap?.records}/${metrics.caps?.stateRecords}`;
		case "restart": return `${metrics.deliveredMessages} delivered, ${metrics.duplicatedOperations} dup, ${metrics.missingOperations} lost, ${metrics.retriesNeeded} retries, ${metrics.lostAcks} committed acks lost to SIGKILL`;
		case "fanout": return (metrics.phases ?? []).map((phase) => `n=${phase.nativeTargets}: ${phase.shimPerSec} shim/s, hb p95 ${phase.heartbeatLatencyMs?.p95} ms, ${phase.daemonCpuSec} cpu-s, rss ${kib(phase.daemonRssBytes)}`).join(" | ");
		default: return "";
	}
}

function percentileText(percentiles) {
	return percentiles ? `${percentiles.p50}/${percentiles.p95}/${percentiles.p99}` : "-";
}

function kib(bytes) {
	return bytes === undefined ? "-" : `${Math.round(bytes / 1024)}K`;
}
