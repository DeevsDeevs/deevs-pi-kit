// One bench run inside its own polygon container: `node inside.mjs <task> <config>`. Stages the logins into this
// container's HOME, exports the fixture, runs the config's lead on the task prompt, then measures and checks.
// Writes /results/result.json plus the raw transcripts (never a credential) next to it.
import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { expiries, stageLogins } from "./stage.mjs";
import { PIN, promptFor, RESULT, RESUME_PROMPT, TASKS } from "./tasks.mjs";

export const CONFIGS = {
	"cc-opus": { harness: "claude", model: "claude-opus-5-5", login: "claude" },
	"pi-sol": { harness: "pi", model: "openai/gpt-6.1-sol", login: "pi:openai" },
	"pi-opus": { harness: "pi", model: "anthropic/claude-opus-5-5", login: "pi:anthropic" },
	"pi-opus-or": { harness: "pi", model: "openrouter/anthropic/claude-opus-5.5", login: "openrouter" },
};

const HOME = "/tmp/home";
const REPO = "/tmp/work/repo";
const OUT = "/results";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (file) => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };

function env(config) {
	const e = {
		PATH: process.env.PATH, LANG: "C.UTF-8", TERM: "xterm-256color", HOME,
		XDG_CONFIG_HOME: join(HOME, ".config"), XDG_DATA_HOME: join(HOME, ".local/share"), XDG_STATE_HOME: join(HOME, ".local/state"), XDG_CACHE_HOME: join(HOME, ".cache"),
		PI_CODING_AGENT_DIR: join(HOME, ".pi/agent"), CLAUDE_CONFIG_DIR: join(HOME, ".claude"), CODEX_HOME: join(HOME, ".codex"),
		PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", GIT_CONFIG_NOSYSTEM: "1",
	};
	// The key file is mounted read-only; it lives only in this process's env and never reaches the results.
	if (config.login === "openrouter") e.OPENROUTER_API_KEY = readFileSync("/secrets/openrouter.key", "utf8").trim();
	return e;
}

function fixture(task) {
	mkdirSync(REPO, { recursive: true });
	// An export, not a clone: the fix commits after `commit` must not be in reach of `git log`.
	execSync(`git --git-dir=/fixture.git archive ${task.commit} | tar -x -C ${REPO}`, { stdio: "inherit" });
	rmSync(join(REPO, "AGENTS.md"), { force: true });
	task.setup?.(REPO);
	// A writable node_modules of links into the read-only kit modules, minus the host's caches: vite writes its config bundle into node_modules/.vite-temp.
	if (task.node_modules) {
		mkdirSync(join(REPO, "node_modules"));
		for (const entry of readdirSync("/kit/node_modules").filter((e) => e === ".bin" || !e.startsWith("."))) symlinkSync(join("/kit/node_modules", entry), join(REPO, "node_modules", entry));
	}
	writeFileSync(join(HOME, ".gitconfig"), "[user]\n\tname = bench\n\temail = bench@invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
	const git = (args) => execSync(`git ${args}`, { cwd: REPO, env: { ...process.env, HOME }, stdio: "ignore" });
	git("init -q"); git("add -A"); git("commit -qm fixture");
}

/** Claude Code headless: `claude -p` keeps running until its background Workflow/Agent tasks finish and their notifications are answered. */
async function claude(config, prompt, task, e) {
	const runs = [];
	const once = (text, resume) => new Promise((resolve) => {
		const n = runs.length + 1;
		const args = ["-p", text, "--model", config.model, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", ...(resume ? ["--resume", resume] : [])];
		const child = spawn("claude", args, { cwd: REPO, env: e, stdio: ["ignore", "pipe", "pipe"] });
		const events = [];
		let buf = "", killed = false, timer;
		child.stdout.on("data", (d) => {
			buf += d;
			for (let i; (i = buf.indexOf("\n")) >= 0;) {
				const line = buf.slice(0, i); buf = buf.slice(i + 1);
				appendFileSync(join(OUT, `claude-stream-${n}.jsonl`), line + "\n");
				let ev; try { ev = JSON.parse(line); } catch { continue; }
				ev.receivedAt = Date.now();
				events.push(ev);
				const launch = ev.type === "assistant" && !ev.parent_tool_use_id && ev.message.content.some((c) => c.type === "tool_use" && ["Workflow", "Agent", "Task"].includes(c.name));
				if (task.restart && !resume && launch && !timer) timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, task.restart.afterFirstAgentMs);
			}
		});
		child.stderr.on("data", (d) => appendFileSync(join(OUT, `claude-stderr-${n}.log`), d));
		const hard = setTimeout(() => { killed = "timeout"; child.kill("SIGKILL"); }, task.timeoutMin * 60_000);
		child.on("close", (code, signal) => { clearTimeout(timer); clearTimeout(hard); runs.push({ events, code, signal, killed }); resolve(); });
	});
	await once(prompt);
	const sid = runs[0].events.find((ev) => ev.type === "system" && ev.subtype === "init")?.session_id;
	if (runs[0].killed === true && sid) await once(RESUME_PROMPT, sid);
	return claudeMetrics(runs, sid);
}

function claudeMetrics(runs, sid, projects = join(HOME, ".claude/projects"), copy = true) {
	const events = runs.flatMap((r) => r.events);
	const results = events.filter((ev) => ev.type === "result");
	const last = results.at(-1);
	const mainAssistant = events.filter((ev) => ev.type === "assistant" && !ev.parent_tool_use_id);
	const u = mainAssistant.at(-1)?.message.usage ?? {};
	// Totals over every transcript of the session (lead, Agent subagents, workflow agents), one usage per API message.
	const all = existsSync(projects) ? readdirSync(projects, { recursive: true }).map((f) => join(projects, f)) : [];
	const files = all.filter((f) => f.endsWith(".jsonl") && !f.endsWith("journal.jsonl"));
	const seen = new Set(), zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const lead = zero(), sub = zero();
	let agents = 0;
	for (const f of files) {
		const isAgent = /\/agent-[^/]+\.jsonl$/.test(f);
		if (isAgent) agents++;
		const acc = isAgent ? sub : lead;
		for (const entry of jsonl(f)) {
			const m = entry.message;
			if (entry.type !== "assistant" || !m?.usage || seen.has(m.id)) continue;
			seen.add(m.id);
			acc.input += m.usage.input_tokens ?? 0; acc.output += m.usage.output_tokens ?? 0;
			acc.cacheRead += m.usage.cache_read_input_tokens ?? 0; acc.cacheWrite += m.usage.cache_creation_input_tokens ?? 0;
		}
	}
	const sum = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;
	const total = Object.fromEntries(Object.keys(lead).map((k) => [k, lead[k] + sub[k]]));
	const workflows = all.filter((f) => /\/workflows\/wf_[^/]+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(f, "utf8")));
	const journals = all.filter((f) => f.endsWith("journal.jsonl"));
	const toolUses = mainAssistant.flatMap((ev) => ev.message.content.filter((c) => c.type === "tool_use"));
	const toolErrors = events.filter((ev) => ev.type === "user" && !ev.parent_tool_use_id && Array.isArray(ev.message.content)).flatMap((ev) => ev.message.content).filter((c) => c.type === "tool_result" && c.is_error);
	const agentToolIds = new Set(toolUses.filter((c) => ["Agent", "Task", "Workflow"].includes(c.name)).map((c) => c.id));
	const notes = events.filter((ev) => ev.type === "system" && ev.subtype === "task_notification");
	if (copy && existsSync(projects)) cpSync(projects, join(OUT, "claude-projects"), { recursive: true });
	return {
		session: sid,
		exit: runs.map((r) => ({ code: r.code, signal: r.signal, killed: r.killed })),
		restarts: runs.length - 1,
		lead_context_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0),
		tokens: { ...total, total: sum(total), lead: sum(lead), subagents: sum(sub), lead_detail: lead, subagents_detail: sub },
		// total_cost_usd is per process; a restarted run adds each process's last figure.
		cost_usd_list: runs.reduce((sum, r) => sum + (r.events.findLast((ev) => ev.type === "result")?.total_cost_usd ?? 0), 0) || null,
		cost_basis: "subscription (list-price estimate from Claude Code)",
		model_usage: last?.modelUsage ?? null,
		lead_turns: results.length,
		lead_messages: new Set(mainAssistant.map((ev) => ev.message.id)).size,
		lead_tool_calls: toolUses.reduce((acc, c) => ({ ...acc, [c.name]: (acc[c.name] ?? 0) + 1 }), {}),
		agents_launched: agents,
		agents_failed: notes.filter((n) => n.status && n.status !== "completed").length
			+ journals.flatMap((f) => jsonl(f)).filter((j) => j.type === "result" && (j.result === null || j.error)).length
			+ toolErrors.filter((c) => agentToolIds.has(c.tool_use_id)).length,
		workflows: workflows.map((w) => ({ agentCount: w.agentCount, durationMs: w.durationMs, status: w.status ?? (w.error ? "failed" : "completed") })),
		notifications: notes.length,
		compactions: events.filter((ev) => ev.type === "system" && ev.subtype === "compact_boundary").length,
		user_relays: 0,
		quota: events.some((ev) => ev.type === "rate_limit_event" && ev.rate_limit_info?.status === "rejected"),
		api_errors: results.filter((r) => r.is_error).map((r) => r.subtype + (r.result ? `: ${String(r.result).slice(0, 200)}` : "")),
	};
}

/** Pi + kit over RPC: the lead settles between turns; background agents wake it with notifications until the result exists. */
async function pi(config, prompt, task, e) {
	const agentDir = join(HOME, ".pi/agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", packages: ["/kit"] }, null, 2));
	writeFileSync(join(agentDir, "pi-kit.json"), JSON.stringify({ lead: null }, null, 2));
	const { rpc } = await import("/polygon/drive.mjs");
	const { dialogs, taskNotes, toolCalls } = await import("/polygon/look.mjs");
	const t = { repo: REPO, env: e, dir: OUT, closers: [] };
	const lead = rpc(t, { model: config.model, answer: true });
	const deadline = Date.now() + task.timeoutMin * 60_000;
	let restarts = 0, stats;
	const quietFor = (ms) => { const last = lead.events.at(-1); return last && Date.now() - last.receivedAt > ms; };
	const settled = () => lead.events.findLast((ev) => ["agent_start", "agent_settled"].includes(ev.type))?.type === "agent_settled";
	const running = () => {
		const launched = toolCalls(lead.events).filter((c) => c.name === "Agent" && !c.isError).length;
		return launched - new Set(taskNotes(lead.events).map((n) => n.taskId)).size;
	};
	await lead.prompt(prompt);
	if (task.restart) {
		const first = await lead.until((ev) => ev.type === "tool_execution_start" && ev.toolName === "Agent", task.timeoutMin * 60_000 / 6).catch(() => undefined);
		if (first) {
			await sleep(task.restart.afterFirstAgentMs);
			await lead.kill9();
			restarts++;
			lead.restart(["--continue"]);
			await sleep(3_000);
			await lead.prompt(RESUME_PROMPT);
		}
	}
	let timedOut = false;
	for (;;) {
		if (Date.now() > deadline) { timedOut = true; break; }
		// An agent orphaned by a restart may never report; two quiet minutes after the result bound that wait.
		if (existsSync(join(REPO, RESULT)) && settled() && quietFor(running() <= 0 ? 20_000 : 120_000)) break;
		await sleep(2_000);
	}
	try { stats = (await lead.send({ type: "get_session_stats" }, 10_000)).data; } catch {}
	const events = lead.events;
	const calls = toolCalls(events);
	const notes = taskNotes(events);
	await Promise.all(t.closers.map((c) => c().catch(() => {})));
	const sessions = join(agentDir, "sessions");
	if (existsSync(sessions)) cpSync(sessions, join(OUT, "pi-sessions"), { recursive: true });
	const tok = stats?.tokens ?? {};
	const subTokens = subagentTokens(events);
	return {
		ended_at: timedOut ? undefined : events.findLast((ev) => ev.type === "agent_settled")?.receivedAt,
		session: stats?.sessionId ?? null,
		exit: [{ timedOut }],
		restarts,
		lead_context_tokens: stats?.contextUsage?.tokens ?? null,
		// The lead's own usage is exact; each subagent reports one total in its notification's <usage>.
		tokens: { input: tok.input ?? null, output: tok.output ?? null, cacheRead: tok.cacheRead ?? null, cacheWrite: tok.cacheWrite ?? null, total: (tok.total ?? 0) + subTokens, lead: tok.total ?? null, subagents: subTokens },
		cost_usd: stats?.cost ?? null,
		cost_basis: config.login === "openrouter" ? "openrouter $ (Pi's per-model pricing)" : "subscription (Pi's list-price estimate)",
		lead_turns: events.filter((ev) => ev.type === "agent_start").length,
		lead_messages: events.filter((ev) => ev.type === "message_end" && ev.message?.role === "assistant").length,
		lead_tool_calls: calls.reduce((acc, c) => ({ ...acc, [c.name]: (acc[c.name] ?? 0) + 1 }), {}),
		agents_launched: calls.filter((c) => c.name === "Agent" && !c.isError).length,
		agents_failed: notes.filter((n) => n.status && n.status !== "completed").length + calls.filter((c) => c.name === "Agent" && c.isError).length,
		notifications: notes.length,
		compactions: events.filter((ev) => ev.type === "compaction_end").length,
		user_relays: dialogs(events),
		quota: false,
		api_errors: events.filter((ev) => ev.type === "message_end" && ev.message?.stopReason === "error").map((ev) => String(ev.message.errorMessage ?? "").slice(0, 200)),
	};
}

/** Each kit subagent reports one token total in its notification's <usage>. */
const subagentTokens = (events) => events.filter((ev) => ev.type === "message_end" && ev.message?.customType === "task-notification")
	.map((ev) => (typeof ev.message.content === "string" ? ev.message.content : ev.message.content.map((b) => b.text ?? "").join("")))
	.reduce((sum, text) => sum + Number(/<subagent_tokens>(\d+)<\/subagent_tokens>/.exec(text)?.[1] ?? 0), 0);

/** Recomputes a finished run's metrics from its saved transcripts (host-side; the check stays as judged in the container). */
function remeasure(dir) {
	const old = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
	let metrics;
	if (old.harness === "claude") {
		const runs = readdirSync(dir).filter((f) => /^claude-stream-\d+\.jsonl$/.test(f)).sort().map((f, i) => ({ events: jsonl(join(dir, f)), ...old.exit?.[i] }));
		metrics = claudeMetrics(runs, old.session, join(dir, "claude-projects"), false);
	} else {
		const events = jsonl(join(dir, "events.jsonl"));
		const sub = subagentTokens(events);
		const lead = old.tokens.lead ?? old.tokens.total;
		metrics = { tokens: { ...old.tokens, total: lead + sub, lead, subagents: sub }, lead_messages: events.filter((ev) => ev.type === "message_end" && ev.message?.role === "assistant").length };
		// Runs from before wall time ended at the last settle counted the harness's quiet wait; recount from the event stream.
		const settledAt = events.findLast((ev) => ev.type === "agent_settled")?.receivedAt;
		if (!old.wall_basis && settledAt && !old.exit?.[0]?.timedOut) Object.assign(metrics, { wall_ms: settledAt - events[0].receivedAt, wall_basis: "first lead event to last settle" });
		delete metrics.tokens.subagents_reported;
	}
	// "pristine" checks only read files the run never changes, so an untouched export of the same commit (BENCH_PRISTINE) stands in for its repo.
	const offline = TASKS[old.task]?.offlineCheck;
	const repo = offline === "pristine" && old.commit === PIN ? process.env.BENCH_PRISTINE : null;
	if ((offline === "no-repo" || repo) && existsSync(join(dir, "task-result.json"))) {
		const check = TASKS[old.task].check(repo, JSON.parse(readFileSync(join(dir, "task-result.json"), "utf8")));
		Object.assign(metrics, { check, status: old.status === "quota" ? "quota" : check.success ? "pass" : "fail" });
	}
	writeFileSync(join(dir, "result.json"), JSON.stringify({ ...old, ...metrics }, null, 2));
}

async function main() {
	if (process.argv[2] === "--remeasure") return process.argv.slice(3).forEach(remeasure);
	const [taskId, configId] = process.argv.slice(2);
	if (taskId === "--models") {
		mkdirSync(HOME, { recursive: true });
		stageLogins(HOME);
		console.log(JSON.stringify(Object.fromEntries(Object.entries(expiries()).map(([k, v]) => [k, v && new Date(v).toISOString()]))));
		return void execSync("pi --list-models", { env: env({}), stdio: "inherit" });
	}
	const task = TASKS[taskId], config = CONFIGS[configId];
	if (!task || !config) throw new Error(`usage: inside.mjs <${Object.keys(TASKS)}> <${Object.keys(CONFIGS)}>`);
	mkdirSync(HOME, { recursive: true });
	const staged = stageLogins(HOME);
	const expiry = expiries()[config.login];
	if (config.login !== "openrouter" && !(expiry > Date.now() + task.timeoutMin * 60_000 * 1.5)) {
		writeFileSync(join(OUT, "result.json"), JSON.stringify({ task: taskId, config: configId, status: "no-login", error: `${config.login} access token expires ${expiry ? new Date(expiry).toISOString() : "never staged"}; refresh the polygon login volume first` }, null, 2));
		return;
	}
	fixture(task);
	const prompt = promptFor(taskId, REPO);
	writeFileSync(join(OUT, "prompt.txt"), prompt);
	const e = env(config);
	const started = Date.now();
	const metrics = await (config.harness === "claude" ? claude : pi)(config, prompt, task, e);
	// Pi ends at its last settle, not when the harness notices the quiet; claude -p ends at exit.
	const wall = (metrics.ended_at ?? Date.now()) - started;
	metrics.wall_basis = metrics.ended_at ? "start to last settle" : "start to exit";
	delete metrics.ended_at;
	let out, parseError;
	try { out = JSON.parse(readFileSync(join(REPO, RESULT), "utf8")); } catch (error) { parseError = String(error).slice(0, 300); }
	// The agents' changes as one patch, so a check can be replayed on a fresh export after the container is gone.
	execSync("git add -A && git diff --cached --binary HEAD > /results/repo.patch && git reset -q", { cwd: REPO, env: { ...process.env, HOME } });
	const check = task.check(REPO, out);
	if (out) cpSync(join(REPO, RESULT), join(OUT, "task-result.json"));
	writeFileSync(join(OUT, "repo.diff"), execSync("git diff HEAD --stat; git status --porcelain", { cwd: REPO, encoding: "utf8" }));
	writeFileSync(join(OUT, "result.json"), JSON.stringify({
		task: taskId, config: configId, harness: config.harness, model: config.model, commit: task.commit === PIN ? PIN : task.commit, staged,
		status: metrics.quota ? "quota" : check.success ? "pass" : "fail", wall_ms: wall, result_parse_error: parseError ?? null, check, ...metrics,
	}, null, 2));
}

await main();
process.exit(0);
