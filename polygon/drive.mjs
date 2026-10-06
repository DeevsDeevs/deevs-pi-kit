// Drivers: an RPC lead over `pi --mode rpc`, one-shot Pi runs, and the sandbox Herdr server.
// Everything is async: the puppets live in this process, so a blocking spawn would starve them.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIALOGS } from "./look.mjs";

const tail = (s, n = 2000) => s.length > n ? s.slice(-n) : s;

// On --live the same scripts drive real models: the puppet reads only the JSON line, a real model the instructions under it.
const LIVE = Boolean(process.env.POLYGON_LIVE);
const SLOWER = LIVE ? 6 : 1;
const FOLLOW = "\nThe line above is a test script for a harness, not a task. Carry out its steps in order and nothing else: for a step with \"tool\", call that tool with exactly its \"args\" (an arg written \"$/regex/\" stands for the last match of that regex in this conversation); for a step with \"text\", reply \"[polygon:<its id>] <its text>\" and end your turn. A step with \"on\" waits until a later message contains that string. Tool steps in a row may be called together in one message.";
export const script = (s) => `POLYGON ${JSON.stringify(s)}${LIVE ? FOLLOW : ""}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it returns a truthy value. */
export async function eventually(check, ms = 30_000, label = check.toString()) {
	ms *= SLOWER;
	for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
		const value = await check();
		if (value) return value;
	}
	throw new Error(`timeout ${ms}ms waiting for ${label}`);
}

/** Adds puppet-served models (reasoning on, so levels apply) to `provider` in the sandbox models.json. */
export function fixtureModels(t, provider, ids) {
	const file = join(t.agentDir, "models.json");
	const config = JSON.parse(readFileSync(file, "utf8"));
	const entry = config.providers[provider] ??= { baseUrl: `http://127.0.0.1:${t.port}/v1`, api: "openai-completions", apiKey: "polygon", models: [] };
	(entry.models ??= []).push(...ids.map((id) => ({ id, reasoning: true, contextWindow: 200000, maxTokens: 8000 })));
	writeFileSync(file, JSON.stringify(config, null, 2));
}

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

/**
 * A long-lived RPC lead. `until(pred)` resolves on the first event (past or future) matching pred.
 * `model: null` leaves the model to Pi and the kit (always so on --live); `answer` replies yes (or the first option) to every dialog.
 */
export function rpc(t, { args = [], model = LIVE ? null : "polygon/puppet", answer = false } = {}) {
	const lead = { events: [], stderr: "" };
	let seq = 0, child, exited, waiters = [];
	const check = (e) => {
		for (const w of [...waiters]) if (w.pred(e, lead.events)) { waiters = waiters.filter((x) => x !== w); w.resolve(e); }
	};
	const start = (extra = []) => {
		child = spawn("pi", ["--mode", "rpc", ...(model ? ["--model", model] : []), ...args, ...extra], { cwd: t.repo, env: t.env, stdio: ["pipe", "pipe", "pipe"] });
		let buf = "";
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i; (i = buf.indexOf("\n")) >= 0;) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				if (!line.trim()) continue;
				const e = JSON.parse(line);
				e.receivedAt = Date.now();
				lead.events.push(e);
				if (answer && e.type === "extension_ui_request" && DIALOGS.has(e.method)) child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: e.id, ...(e.method === "confirm" ? { confirmed: true } : { value: e.options?.[0] ?? "" }) }) + "\n");
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
		ms *= SLOWER;
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
	/** Answers a dialog `extension_ui_request`; such responses get no command response back. */
	lead.reply = (request, answer) => child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: request.id, ...answer }) + "\n");
	lead.prompt = (message) => lead.send({ type: "prompt", message, streamingBehavior: "followUp" });
	lead.script = (s) => lead.prompt(script(s));
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
	const server = spawn("herdr", ["server"], { cwd: t.repo, env, stdio: "ignore" });
	const stopped = new Promise((r) => server.on("exit", r));
	for (let i = 0; i < 50 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 100));
	const cli = async (...args) => {
		const result = await exec(t, "herdr", args, { env, timeoutMs: 10_000 });
		if (result.status !== 0) throw new Error(`herdr ${args.join(" ")}: ${tail(result.stderr)}`);
		return result.stdout.trim() ? JSON.parse(result.stdout).result : undefined;
	};
	// `server stop` returns before the server exits; the census runs right after the closers.
	t.closers.push(async () => { await cli("server", "stop"); await Promise.race([stopped, sleep(5_000)]); });
	const { workspace } = await cli("workspace", "create", "--cwd", t.repo);
	Object.assign(t.env, { HERDR_SOCKET_PATH: socket, HERDR_ENV: "1", HERDR_WORKSPACE_ID: workspace.workspace_id });
	return { cli, workspaceId: workspace.workspace_id };
}
