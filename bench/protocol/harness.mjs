import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const repo = resolve(fileURLToPath(import.meta.url), "../../..");
const serviceMain = join(repo, "extensions/runtime/service/main.ts");
const resultsDir = join(repo, "bench/results/protocol");
const cleanups = [];

/** One connection, one request in flight: the daemon answers a connection's lines in order. */
export class Rpc {
	static open(socketPath) {
		return new Promise((ok, fail) => {
			const socket = createConnection(socketPath);
			const rpc = new Rpc(socket);
			socket.once("error", fail);
			socket.once("connect", () => { socket.off("error", fail); ok(rpc); });
		});
	}

	constructor(socket) {
		this.socket = socket;
		this.waiting = [];
		this.tail = Promise.resolve();
		this.nextId = 0;
		this.socket.on("error", (error) => this.fail(error));
		this.socket.on("close", () => this.fail(new Error("runtime closed the connection")));
		createInterface({ input: socket }).on("line", (line) => {
			const settle = this.waiting.shift();
			if (settle) settle.ok(JSON.parse(line));
		});
	}

	fail(error) {
		for (const settle of this.waiting.splice(0)) settle.fail(error);
	}

	/** Queued so one connection never has two requests outstanding. */
	call(method, params) {
		const sent = this.tail.then(() => this.request(method, params), () => this.request(method, params));
		this.tail = sent.catch(() => {});
		return sent;
	}

	request(method, params) {
		const id = `req_${++this.nextId}`;
		if (this.socket.destroyed) return Promise.reject(new Error(`${method}: connection is closed`));
		return new Promise((ok, fail) => {
			this.waiting.push({ ok, fail });
			this.socket.write(`${JSON.stringify({ v: 1, id, method, params })}\n`);
		}).then((response) => {
			if (response.ok) return response.result;
			const error = new Error(`${method}: ${response.error?.message ?? "no error body"}`);
			error.code = response.error?.code ?? "unknown";
			throw error;
		});
	}

	close() {
		this.socket.destroy();
	}
}

/**
 * A daemon of its own, in a temp root, with a fake `herdr` first on its PATH: nothing here can
 * reach the user's live runtime, Herdr session or home directory.
 */
export async function setup(options = {}) {
	const base = mkdtempSync(join(tmpdir(), "pi-kit-bench-"));
	const projectRoot = join(base, "project");
	const runtimeRoot = join(base, "agent", "runtime");
	const sessions = join(base, "sessions");
	const bin = join(base, "bin");
	for (const directory of [projectRoot, sessions, bin]) mkdirSync(directory, { recursive: true });
	mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
	const herdrLog = join(base, "herdr.log");
	writeFileSync(join(bin, "herdr"), herdrShim(herdrLog, projectRoot, options.herdrDelayMs ?? 20), { mode: 0o700 });
	const env = {
		...process.env,
		PATH: `${bin}:${process.env.PATH}`,
		PI_CODING_AGENT_DIR: join(base, "agent"),
		HERDR_SOCKET_PATH: join(base, "absent-herdr.sock"),
	};
	delete env.PI_PACKAGE_DIR;

	const bench = {
		base,
		projectRoot,
		runtimeRoot,
		herdrLog,
		statePath: join(runtimeRoot, "state.v1.json"),
		socketPath: join(runtimeRoot, "runtime.sock"),
		targets: new Map(),
		daemon: undefined,
		control: undefined,
		heartbeat: undefined,
		connections: [],

		async connect() {
			const rpc = await Rpc.open(bench.socketPath);
			bench.connections.push(rpc);
			return rpc;
		},

		async start() {
			bench.daemon = spawn(process.execPath, ["--experimental-strip-types", serviceMain, "--root", runtimeRoot], { stdio: ["ignore", "pipe", "pipe"], env });
			bench.stderr = "";
			bench.daemon.stderr.on("data", (chunk) => { bench.stderr = (bench.stderr + chunk).slice(-8192); });
			const [line] = await Promise.race([
				once(createInterface({ input: bench.daemon.stdout }), "line"),
				once(bench.daemon, "exit").then(() => { throw new Error(`daemon exited: ${bench.stderr}`); }),
			]);
			const ready = JSON.parse(line);
			if (ready.status !== "ready") throw new Error(`daemon did not report readiness: ${line}`);
			bench.control = await bench.connect();
			return ready;
		},

		/** A Pi target: session file, registration, held participant and its own mail namespace. */
		async addPi(name, { issue = true } = {}) {
			const sessionId = `${name}-${process.pid}-${bench.targets.size}`;
			const sessionFile = join(sessions, `${name}.jsonl`);
			writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: projectRoot })}\n`);
			const target = { name, sessionId, sessionFile };
			bench.targets.set(name, target);
			target.reg = await bench.control.call("pi.register", { projectRoot, piSessionId: sessionId, piSessionFile: sessionFile });
			const acquired = await bench.control.call("participant.acquire", { ...auth(target), protocol: "bench", participantId: name });
			target.participant = acquired.participant;
			if (issue) await bench.issue(target, target);
			return target;
		},

		/** `caller` proves the project/protocol; the namespace belongs to `holder`. */
		async issue(caller, holder) {
			const issued = await bench.control.call("messaging.issue", {
				...auth(caller),
				participantKey: holder.participant.participantKey,
				expectedGeneration: holder.participant.generation,
				confirmed: true,
			});
			const descriptor = JSON.parse(readFileSync(issued.descriptorPath, "utf8"));
			holder.namespace = { namespaceId: descriptor.namespaceId, secret: descriptor.secret };
			return holder.namespace;
		},

		/** Registrations are in-memory and lease for 30 s, so anything long-running renews them. */
		keepAlive(everyMs = 10_000) {
			bench.heartbeat = setInterval(() => void bench.beat().catch(() => {}), everyMs);
			bench.heartbeat.unref();
		},

		async beat() {
			for (const target of bench.targets.values()) {
				if (target.reg) await bench.control.call(target.agent ? "bridge.heartbeat" : "pi.heartbeat", auth(target));
			}
		},

		async reregister() {
			for (const target of bench.targets.values()) {
				target.reg = await bench.control.call("pi.register", { projectRoot, piSessionId: target.sessionId, piSessionFile: target.sessionFile });
			}
		},

		async kill(signal = "SIGKILL") {
			if (!bench.daemon || bench.daemon.exitCode !== null) return;
			for (const rpc of bench.connections.splice(0)) rpc.close();
			bench.daemon.kill(signal);
			await once(bench.daemon, "exit");
		},

		async stop() {
			clearInterval(bench.heartbeat);
			for (const rpc of bench.connections.splice(0)) rpc.close();
			await bench.kill("SIGTERM");
			rmSync(base, { recursive: true, force: true });
		},
	};
	cleanups.push(() => bench.stop().catch(() => {}));
	await bench.start();
	return bench;
}

export function auth(target) {
	return { registrationId: target.reg.registrationId, registrationKey: target.reg.registrationKey };
}

export function body(text) {
	return Buffer.from(text, "utf8").toString("base64");
}

/** A messaging call is capacity-limited (12 in flight); a conflict published nothing, so the same operation retries. */
export async function withRetry(call, onRetry = () => {}) {
	for (let attempt = 0; ; attempt++) {
		try { return await call(); }
		catch (error) {
			if (!/capacity is exhausted/.test(error.message) || attempt > 200) throw error;
			onRetry();
			await sleep(2 + attempt);
		}
	}
}

export function sleep(ms) {
	return new Promise((ok) => setTimeout(ok, ms));
}

export async function pool(size, items, worker) {
	const queue = items.slice();
	const lanes = Array.from({ length: size }, async (_unused, lane) => {
		for (let item = queue.shift(); item !== undefined; item = queue.shift()) await worker(item, lane);
	});
	await Promise.all(lanes);
}

export function percentiles(samples) {
	const sorted = [...samples].sort((left, right) => left - right);
	const at = (p) => round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0);
	return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}

export function round(value, digits = 2) {
	return Number.isFinite(value) ? Number(value.toFixed(digits)) : value;
}

export function fileSize(path) {
	try { return statSync(path).size; } catch { return 0; }
}

export function rssBytes(pid) {
	const line = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
	return line ? Number(line[1]) * 1024 : 0;
}

/** utime + stime from /proc/<pid>/stat, in seconds. */
export function cpuSeconds(pid) {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return (Number(fields[11]) + Number(fields[12])) / 100;
}

export function writeResult(result) {
	mkdirSync(resultsDir, { recursive: true });
	writeFileSync(join(resultsDir, `${result.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
	return result;
}

/** Runs one measurement, always writes its result file, and exits 1 on any failed invariant. */
export async function run(name, measure) {
	const metrics = {};
	const failures = [];
	const started = performance.now();
	try {
		await measure({ metrics, failures, check(condition, message) { if (!condition) failures.push(message); } });
	} catch (error) {
		failures.push(`threw: ${error?.stack ?? error}`);
	} finally {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	}
	metrics.durationSec = round((performance.now() - started) / 1000);
	const result = writeResult({ name, ok: failures.length === 0, metrics, failures });
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	if (!result.ok) process.exitCode = 1;
}

function herdrShim(logPath, projectRoot, delayMs) {
	return `#!/bin/sh
printf '%s %s\\n' "$(date +%s.%N)" "$*" >> ${JSON.stringify(logPath)}
sleep ${delayMs / 1000}
if [ "$1" = agent ] && [ "$2" = get ]; then
	printf '{"result":{"agent":{"name":"%s","cwd":"%s","tab_id":"tab_%s","workspace_id":"ws_bench","agent_status":"idle"}}}\\n' "$3" ${JSON.stringify(projectRoot)} "$3"
	exit 0
fi
printf '{"result":{"ok":true}}\\n'
`;
}
