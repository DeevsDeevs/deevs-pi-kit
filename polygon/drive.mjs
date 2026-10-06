// Drivers: an RPC lead over `pi --mode rpc`, one-shot Pi runs, and the sandbox Herdr server.
// Everything is async: the puppets live in this process, so a blocking spawn would starve them.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const tail = (s, n = 2000) => s.length > n ? s.slice(-n) : s;

export function exec(t, cmd, args, { timeoutMs = 60_000, input, env = t.env } = {}) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: t.repo, env, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr += d; });
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
		child.stdin.end(input ?? "");
	});
}

/** One-shot `pi` (print or json mode); json lines from both streams are parsed into `events`. */
export async function pi(t, args, opts) {
	const result = await exec(t, "pi", args, opts);
	result.events = `${result.stdout}\n${result.stderr}`.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
	return result;
}

/** A long-lived RPC lead. `until(pred)` resolves on the first event (past or future) matching pred. */
export function rpc(t, { args = [] } = {}) {
	const lead = { events: [], stderr: "" };
	let seq = 0, child, exited, waiters = [];
	const check = (e) => {
		for (const w of [...waiters]) if (w.pred(e, lead.events)) { waiters = waiters.filter((x) => x !== w); w.resolve(e); }
	};
	const start = (extra = []) => {
		child = spawn("pi", ["--mode", "rpc", "--model", "polygon/puppet", ...args, ...extra], { cwd: t.repo, env: t.env, stdio: ["pipe", "pipe", "pipe"] });
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i; (i = buf.indexOf("\n")) >= 0;) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				const e = JSON.parse(line);
				lead.events.push(e);
				check(e);
			}
		});
		child.stderr.on("data", (d) => { lead.stderr = tail(lead.stderr + d, 8000); });
		exited = new Promise((r) => child.on("exit", (code, signal) => {
			for (const w of waiters) w.reject(new Error(`pi exited (${code ?? signal}) before ${w.label}; stderr: ${tail(lead.stderr)}`));
			waiters = [];
			r({ code, signal });
		}));
		lead.pid = child.pid;
	};
	lead.until = (pred, ms = 30_000, label = pred.toString()) => new Promise((resolve, reject) => {
		const hit = lead.events.find((e) => pred(e, lead.events));
		if (hit) return resolve(hit);
		const timer = setTimeout(() => {
			waiters = waiters.filter((w) => w !== waiter);
			reject(new Error(`timeout ${ms}ms waiting for ${label}; stderr: ${tail(lead.stderr)}`));
		}, ms);
		const waiter = { pred, label, resolve: (e) => { clearTimeout(timer); resolve(e); }, reject: (err) => { clearTimeout(timer); reject(err); } };
		waiters.push(waiter);
	});
	lead.send = async (cmd, ms) => {
		const id = `polygon-${++seq}`;
		child.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
		const response = await lead.until((e) => e.type === "response" && e.id === id, ms, `response to ${cmd.type}`);
		if (!response.success) throw new Error(`${cmd.type} failed: ${JSON.stringify(response).slice(0, 500)}`);
		return response;
	};
	lead.prompt = (message) => lead.send({ type: "prompt", message });
	lead.script = (script) => lead.prompt(`POLYGON ${JSON.stringify(script)}`);
	lead.kill9 = async () => { child.kill("SIGKILL"); await exited; };
	lead.restart = async (extra = ["--continue"]) => { await lead.kill9(); start(extra); };
	lead.close = async () => {
		child.stdin.end();
		child.kill("SIGTERM");
		const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
		await exited;
		clearTimeout(timer);
	};
	start();
	t.closers.push(async () => {
		await lead.close();
		appendFileSync(join(t.dir, "events.jsonl"), lead.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
		appendFileSync(join(t.dir, "pi-stderr.log"), lead.stderr);
	});
	return lead;
}

/** Starts `herdr server` under the sandbox HOME and points later leads at one workspace in it. */
export async function herdr(t) {
	const socket = join(t.home, "herdr.sock");
	const env = { ...t.env, HERDR_SOCKET_PATH: socket };
	spawn("herdr", ["server"], { cwd: t.repo, env, stdio: "ignore" });
	for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
	const cli = async (...args) => {
		const result = await exec(t, "herdr", args, { env, timeoutMs: 10_000 });
		if (result.status !== 0) throw new Error(`herdr ${args.join(" ")}: ${tail(result.stderr)}`);
		return JSON.parse(result.stdout).result;
	};
	t.closers.push(() => cli("server", "stop"));
	const { workspace } = await cli("workspace", "create", "--cwd", t.repo);
	Object.assign(t.env, { HERDR_SOCKET_PATH: socket, HERDR_ENV: "1", HERDR_WORKSPACE_ID: workspace.workspace_id });
	return { cli, workspaceId: workspace.workspace_id };
}
