import { readFileSync } from "node:fs";
import { auth, body, cpuSeconds, percentiles, round, rssBytes, run, setup, sleep, withRetry } from "./harness.mjs";

const SIZES = (process.env.BENCH_SIZES ?? "1,4,12").split(",").map(Number);
const WINDOW_MS = Number(process.env.BENCH_WINDOW_MS ?? 30_000);
const HEARTBEAT_MS = 500;

await run("fanout", async ({ metrics, check }) => {
	metrics.windowSec = WINDOW_MS / 1000;
	metrics.heartbeatIntervalMs = HEARTBEAT_MS;
	metrics.hostVerifier = "herdr CLI shim first on the daemon's PATH (service/herdr-cli.ts execs `herdr agent get <name>`)";
	metrics.phases = [];
	for (const size of SIZES) metrics.phases.push(await phase(size, check));
	check(metrics.phases.every((entry) => entry.shimInvocations > 0), "the daemon never ran the herdr shim");
	check(metrics.phases.every((entry) => entry.heartbeatFailures === 0), "a bridge.heartbeat failed");
});

async function phase(size, check) {
	const bench = await setup();
	bench.keepAlive(5_000);
	const caller = await bench.addPi("caller");
	const natives = [];
	for (let index = 0; index < size; index++) {
		const bound = await bench.control.call("bridge.bind", {
			...auth(caller),
			agentName: `bench_n${index}`,
			driver: "claude-code",
			profile: "read-only",
			protocol: "bench",
			participantId: `n${index}`,
			callerParticipantKey: caller.participant.participantKey,
			expectedCallerGeneration: caller.participant.generation,
		});
		const native = { name: `n${index}`, agent: true, reg: bound, participant: { participantKey: bound.participantKey, generation: bound.holderGeneration } };
		// A wake needs an issued namespace and unread mail, so the sweeper has real work in the window.
		await bench.issue(caller, native);
		await withRetry(() => bench.control.call("messaging.send", {
			...caller.namespace,
			operationId: `wake_${index}`,
			participantId: native.name,
			bodyBase64: body(`unread mail for ${native.name}`),
		}));
		native.rpc = await bench.connect();
		natives.push(native);
	}

	const shimBefore = countShim(bench.herdrLog);
	const cpuBefore = cpuSeconds(bench.daemon.pid);
	const latencies = [];
	let failures = 0;
	let beats = 0;
	const started = performance.now();
	while (performance.now() - started < WINDOW_MS) {
		const tick = performance.now();
		await Promise.all(natives.map(async (native) => {
			const at = performance.now();
			try {
				await native.rpc.call("bridge.heartbeat", auth(native));
				latencies.push(performance.now() - at);
			} catch { failures++; }
			beats++;
		}));
		await sleep(Math.max(0, HEARTBEAT_MS - (performance.now() - tick)));
	}
	const elapsed = (performance.now() - started) / 1000;
	const shim = countShim(bench.herdrLog);
	const result = {
		nativeTargets: size,
		heartbeats: beats,
		heartbeatFailures: failures,
		heartbeatLatencyMs: percentiles(latencies),
		shimInvocations: shim.total - shimBefore.total,
		shimGetAgent: shim.get - shimBefore.get,
		shimPrompts: shim.prompt - shimBefore.prompt,
		shimPerSec: round((shim.total - shimBefore.total) / elapsed),
		daemonCpuSec: round(cpuSeconds(bench.daemon.pid) - cpuBefore, 3),
		daemonRssBytes: rssBytes(bench.daemon.pid),
		elapsedSec: round(elapsed),
	};
	result.cpuSecPerHeartbeat = round(result.daemonCpuSec / Math.max(1, beats), 5);
	check(result.shimPrompts > 0, `${size} native targets with unread mail produced no wake prompt`);
	await bench.stop();
	return result;
}

function countShim(logPath) {
	let lines = [];
	try { lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean); } catch {}
	return {
		total: lines.length,
		get: lines.filter((line) => line.includes("agent get")).length,
		prompt: lines.filter((line) => line.includes("agent prompt")).length,
	};
}
