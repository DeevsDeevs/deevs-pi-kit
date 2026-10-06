// Orchestration bench, host side: one polygon container per (task, config, repetition), then a chart-ready summary.
//   node bench/orchestration/run.mjs --tasks t1,t2 --configs cc-opus --reps 2 --parallel 4
//   node bench/orchestration/run.mjs --summarize <run> [--out file]
// Logins come only from the polygon's pi-kit-polygon-login volume, mounted read-only; see README.md.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TASKS } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const RESULTS = join(ROOT, "bench/results/orchestration");
const CONFIGS = ["cc-opus", "pi-sol", "pi-opus", "pi-opus-or"];
const OPENROUTER_KEY = join(homedir(), ".config/pi-kit-bench/openrouter.key");

const { values: opts } = parseArgs({ options: {
	tasks: { type: "string", default: Object.keys(TASKS).join(",") }, configs: { type: "string", default: "cc-opus" },
	reps: { type: "string", default: "1" }, parallel: { type: "string", default: "4" }, run: { type: "string" },
	summarize: { type: "string" }, out: { type: "string" }, models: { type: "boolean" }, freshen: { type: "boolean" },
} });

/** The polygon's image, same tag rule as polygon/run.mjs; build it there with `npm run polygon -- --list` first if missing. */
function image() {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const args = { PI_VERSION: pkg.devDependencies["@earendil-works/pi-coding-agent"], PI_RUNTIME: "bun", CLAUDE_VERSION: "latest", CODEX_VERSION: "latest" };
	const containerfile = join(ROOT, "polygon/Containerfile");
	const tag = `localhost/pi-kit-polygon:${createHash("sha256").update(readFileSync(containerfile)).update(JSON.stringify(args)).digest("hex").slice(0, 12)}`;
	if (spawnSync("podman", ["image", "exists", tag]).status === 0) return tag;
	const build = spawnSync("podman", ["build", "-t", tag, "-f", containerfile, ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]), join(ROOT, "polygon")], { stdio: ["ignore", 2, 2] });
	if (build.status !== 0) process.exit(1);
	return tag;
}

/** A bare mirror of this repo; containers export task commits from it with `git archive`, so no later history leaks in. */
function fixture() {
	const bare = join(RESULTS, "fixture.git");
	if (!existsSync(bare)) spawnSync("git", ["clone", "-q", "--bare", "--local", ROOT, bare], { stdio: "inherit" });
	else spawnSync("git", ["--git-dir", bare, "fetch", "-q", ROOT, "+refs/heads/*:refs/heads/*"], { stdio: "inherit" });
	return bare;
}

function runOne(img, bare, dir, task, config) {
	mkdirSync(dir, { recursive: true });
	const mounts = [`pi-kit-polygon-login:/login:ro`, `${HERE}:/bench:ro`, `${join(ROOT, "polygon")}:/polygon:ro`, `${ROOT}:/kit:ro`, `${bare}:/fixture.git:ro`, `${dir}:/results`];
	const modules = join(ROOT, "node_modules");
	if (lstatSync(modules).isSymbolicLink()) mounts.push(`${realpathSync(modules)}:${realpathSync(modules)}:ro`);
	if (config === "pi-opus-or") mounts.push(`${OPENROUTER_KEY}:/secrets/openrouter.key:ro`);
	const name = `bench-orch-${dir.split("/").slice(-2).join("-")}`;
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn("podman", ["run", "--rm", "--userns=keep-id", "--name", name, ...mounts.flatMap((m) => ["-v", m]), img, "node", "/bench/inside.mjs", task, config], { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (d) => writeFileSync(join(dir, "container.log"), d, { flag: "a" }));
		child.stderr.on("data", (d) => writeFileSync(join(dir, "container.log"), d, { flag: "a" }));
		// The inside runner enforces the task timeout; this is the backstop for a wedged container.
		const backstop = setTimeout(() => spawnSync("podman", ["kill", name]), (TASKS[task].timeoutMin * 2 + 10) * 60_000);
		child.on("close", (code) => {
			clearTimeout(backstop);
			let result;
			try { result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")); } catch { result = { task, config, status: "error", error: `container exited ${code} without result.json; see container.log` }; writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2)); }
			console.log(`${result.status.padEnd(8)} ${task} ${config} ${dir.split("/").at(-1)} ${Math.round((Date.now() - started) / 1000)}s ${JSON.stringify(result.check ?? result.error ?? "").slice(0, 160)}`);
			resolve(result);
		});
	});
}

const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/** `run` may name several run sets, comma-separated; the summary lands in the first one's directory. */
function summarize(run) {
	const sets = run.split(",");
	const rows = sets.flatMap((set) => readdirSync(join(RESULTS, set), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(RESULTS, set, d.name, "result.json")))
		.map((d) => ({ set, id: d.name, ...JSON.parse(readFileSync(join(RESULTS, set, d.name, "result.json"), "utf8")) })));
	const runs = rows.map((r) => ({
		set: r.set, id: r.id, task: r.task, config: r.config, model: r.model ?? null, status: r.status, success: r.status === "pass",
		wall_s: r.wall_ms ? Math.round(r.wall_ms / 1000) : null, lead_context_tokens: r.lead_context_tokens ?? null,
		tokens_total: r.tokens?.total ?? null, tokens_input: r.tokens?.input ?? null, tokens_output: r.tokens?.output ?? null,
		tokens_cache_read: r.tokens?.cacheRead ?? null, tokens_cache_write: r.tokens?.cacheWrite ?? null,
		cost_usd: r.cost_usd ?? null, cost_usd_list_estimate: r.cost_usd_list ?? null, cost_basis: r.cost_basis ?? null,
		agents_launched: r.agents_launched ?? null, agents_failed: r.agents_failed ?? null, notifications: r.notifications ?? null,
		compactions: r.compactions ?? null, user_relays: r.user_relays ?? null, restarts: r.restarts ?? 0, lead_turns: r.lead_turns ?? null, lead_messages: r.lead_messages ?? null,
		tokens_lead: r.tokens?.lead ?? null, tokens_subagents: r.tokens?.subagents ?? null,
		check: r.check ?? null, error: r.error ?? null,
	}));
	const cells = {};
	for (const r of runs) ((cells[r.task] ??= {})[r.config] ??= []).push(r);
	const matrix = Object.fromEntries(Object.entries(cells).map(([task, byConfig]) => [task, Object.fromEntries(Object.entries(byConfig).map(([config, rs]) => [config, {
		n: rs.length, pass: rs.filter((r) => r.success).length,
		wall_s_median: median(rs.map((r) => r.wall_s)), lead_context_tokens_median: median(rs.map((r) => r.lead_context_tokens)),
		tokens_total_median: median(rs.map((r) => r.tokens_total)), tokens_output_median: median(rs.map((r) => r.tokens_output)),
		cost_usd_list_estimate_median: median(rs.map((r) => r.cost_usd_list_estimate ?? r.cost_usd)),
		agents_launched_median: median(rs.map((r) => r.agents_launched)), agents_failed_total: rs.reduce((a, r) => a + (r.agents_failed ?? 0), 0),
		lead_messages_median: median(rs.map((r) => r.lead_messages)), tokens_subagents_median: median(rs.map((r) => r.tokens_subagents)),
		notifications_median: median(rs.map((r) => r.notifications)), compactions_total: rs.reduce((a, r) => a + (r.compactions ?? 0), 0),
		user_relays_total: rs.reduce((a, r) => a + (r.user_relays ?? 0), 0),
	}]))]));
	const summary = { run, tasks: Object.fromEntries(Object.entries(TASKS).map(([id, t]) => [id, { title: t.title, commit: t.commit }])), matrix, runs };
	writeFileSync(join(RESULTS, sets[0], "summary.json"), JSON.stringify(summary, null, 2));
	if (opts.out) { mkdirSync(dirname(opts.out), { recursive: true }); copyFileSync(join(RESULTS, sets[0], "summary.json"), opts.out); }
	return summary;
}

/** The polygon's own serial freshen (refreshes the volume's tokens); its staged copy lands on a tmpfs and dies with the container. */
function freshen(img) {
	const env = ["HOME=/login", "PI_CODING_AGENT_DIR=/login/.pi/agent", "CLAUDE_CONFIG_DIR=/login/.claude", "CODEX_HOME=/login/.codex", "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0", "DISABLE_AUTOUPDATER=1", "DISABLE_TELEMETRY=1", "POLYGON_FRESHEN=1"];
	return spawnSync("podman", ["run", "--rm", "--userns=keep-id", "-v", "pi-kit-polygon-login:/login:U", "-v", `${join(ROOT, "polygon")}:/polygon:ro`, "--tmpfs", "/results:U",
		...env.flatMap((e) => ["-e", e]), "-w", "/tmp", img, "node", "/polygon/run.mjs"], { stdio: "inherit" }).status;
}

async function main() {
	if (opts.freshen) process.exit(freshen(image()));
	if (opts.models) return void spawnSync("podman", ["run", "--rm", "--userns=keep-id", "-v", "pi-kit-polygon-login:/login:ro", "-v", `${HERE}:/bench:ro`, image(), "node", "/bench/inside.mjs", "--models"], { stdio: "inherit" });
	if (opts.summarize) return console.log(JSON.stringify(summarize(opts.summarize).matrix, null, 2));
	const tasks = opts.tasks.split(","), configs = opts.configs.split(",");
	for (const t of tasks) if (!TASKS[t]) throw new Error(`unknown task ${t}`);
	for (const c of configs) if (!CONFIGS.includes(c)) throw new Error(`unknown config ${c}`);
	const run = opts.run ?? new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const img = image(), bare = fixture();
	// Repetitions interleave so a quota stop leaves every task covered once before any runs twice.
	const jobs = [];
	for (let rep = 1; rep <= Number(opts.reps); rep++) for (const config of configs) for (const task of tasks) jobs.push({ task, config, dir: join(RESULTS, run, `${task}-${config}-r${rep}`) });
	console.log(`bench: run ${run}, ${jobs.length} jobs, ${opts.parallel} at a time, image ${img}`);
	let next = 0, stop;
	await Promise.all(Array.from({ length: Math.min(Number(opts.parallel), jobs.length) }, async () => {
		while (next < jobs.length && !stop) {
			const job = jobs[next++];
			if (existsSync(join(job.dir, "result.json"))) continue;
			const result = await runOne(img, bare, job.dir, job.task, job.config);
			if (result.status === "quota" || result.status === "no-login") stop = `${result.status} in ${job.task} ${job.config}`;
		}
	}));
	if (stop) console.log(`bench: stopped scheduling: ${stop}`);
	console.log(JSON.stringify(summarize(run).matrix, null, 2));
}

await main();
