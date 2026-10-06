// Polygon runner. On the host it ensures the sandbox image and runs one container per polygon run;
// inside that container (POLYGON_IN_CONTAINER) it runs the scenarios in a worker pool and writes the summary.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { requests } from "./look.mjs";
import { sandbox } from "./sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const LOGIN_VOLUME = "pi-kit-polygon-login";
const { values: opts } = parseArgs({ options: {
	only: { type: "string" }, gate: { type: "string" }, slow: { type: "boolean" }, live: { type: "boolean" },
	list: { type: "boolean" }, login: { type: "boolean" }, kit: { type: "string", default: ROOT }, pi: { type: "string" },
	"pi-runtime": { type: "string", default: "bun" }, smoke: { type: "boolean" }, "max-requests": { type: "string", default: "400" },
} });
if (!["bun", "node"].includes(opts["pi-runtime"])) {
	console.error(`polygon: --pi-runtime is bun (Pi's release binary, the default) or node (Pi from npm).`);
	process.exit(1);
}
const SMOKE = ["agent-background", "model-inherit"];
if (opts.smoke) opts.live = true;
// The polygon's own logins; the login and freshen containers see the volume with these paths, scenarios a sanitized copy.
const LOGIN_ENV = ["HOME=/login", "PI_CODING_AGENT_DIR=/login/.pi/agent", "CLAUDE_CONFIG_DIR=/login/.claude", "CODEX_HOME=/login/.codex",
	"PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0", "DISABLE_AUTOUPDATER=1", "DISABLE_TELEMETRY=1"];
// Pi refreshes without a model call (and early, so no token expires mid-run); Claude and Codex refresh on one tiny request.
const LOGINS = [
	{ name: "Pi (openai-codex)", required: true, requests: 0, files: [".pi/agent/auth.json"], argv: ["pi", "auth", "print-bearer-token", "--provider", "openai-codex", "--min-expiry", "2h"] },
	{ name: "Claude Code", requests: 1, files: [".claude/.credentials.json", ".claude/.claude.json"], argv: ["claude", "-p", "Reply with the single word ok."] },
	{ name: "Codex", requests: 1, files: [".codex/auth.json"], argv: ["codex", "exec", "--skip-git-repo-check", "Reply with the single word ok."] },
];

async function scenarios() {
	const dir = join(HERE, "scenarios");
	const files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
	return Promise.all(files.map(async (f) => (await import(pathToFileURL(join(dir, f)).href)).default));
}

function select(all) {
	const only = opts.only?.split(",") ?? (opts.smoke ? SMOKE : undefined);
	return all.filter((s) => (only ? only.includes(s.name) : !s.slow || opts.slow)
		&& (!opts.gate || [s.gate].flat().includes(opts.gate))
		&& (!opts.live || s.live));
}

// A scenario written ahead of its feature carries `pending: "<the step that makes it pass>"`; only --only runs it.
const isSkipped = (s) => s.pending && !opts.only;

function ensureImage() {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const args = { PI_VERSION: opts.pi ?? pkg.devDependencies["@earendil-works/pi-coding-agent"], PI_RUNTIME: opts["pi-runtime"], CLAUDE_VERSION: "latest", CODEX_VERSION: "latest" };
	const containerfile = join(HERE, "Containerfile");
	// ponytail: "latest" is resolved once per tag; remove the image to pick up new Claude/Codex releases.
	const tag = createHash("sha256").update(readFileSync(containerfile)).update(JSON.stringify(args)).digest("hex").slice(0, 12);
	const image = `localhost/pi-kit-polygon:${tag}`;
	const exists = spawnSync("podman", ["image", "exists", image]);
	if (exists.error) {
		console.error(`polygon: cannot run podman (${exists.error.message}); the polygon needs rootless Podman, see polygon/README.md.`);
		process.exit(1);
	}
	if (exists.status === 0) return image;
	console.error(`polygon: building ${image} (${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(" ")})`);
	const build = spawnSync("podman", ["build", "-t", image, "-f", containerfile, ...Object.entries(args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]), HERE], { stdio: ["ignore", 2, 2] });
	if (build.status !== 0) process.exit(build.status ?? 1);
	return image;
}

function kitSource(results) {
	if (opts.kit === "installed") return join(homedir(), ".pi/agent/git/github.com/DeevsDeevs/deevs-pi-kit");
	if (opts.kit !== "clone") return resolve(opts.kit);
	const clone = join(results, "kit");
	if (spawnSync("git", ["clone", "-q", "--local", ROOT, clone], { stdio: "inherit" }).status !== 0) process.exit(1);
	return clone;
}

async function host() {
	if (opts.list) {
		for (const s of await scenarios()) console.log(`${s.name.padEnd(24)} ${[s.gate].flat().join(",").padEnd(8)} ${[s.slow && "slow", s.live && "live", s.pending && `pending: ${s.pending}`].filter(Boolean).join(" ")}`);
		return;
	}
	if (!opts.login && !select(await scenarios()).length) {
		console.error(`polygon: no scenario matches${opts.live ? "; none is marked live: true yet" : ""}.`);
		process.exit(1);
	}
	const image = ensureImage();
	if (opts.login) {
		console.error(`polygon: three logins follow; everything lands in the ${LOGIN_VOLUME} Podman volume, never in your own homes.`);
		const steps = [
			"echo; echo 'polygon login 1/3, Pi: type /login, choose ChatGPT (openai-codex), finish in your browser, then /quit.'", "pi",
			"echo; echo 'polygon login 2/3, Claude Code:'", "claude auth login",
			"echo; echo 'polygon login 3/3, Codex (device code):'", "codex login --device-auth",
		];
		// Host networking lets the browser's OAuth callback to localhost reach the CLI in the container.
		const login = spawnSync("podman", ["run", "-it", "--rm", "--userns=keep-id", "--network=host", "-v", `${LOGIN_VOLUME}:/login:U`,
			...LOGIN_ENV.flatMap((e) => ["-e", e]), "-w", "/login", image, "bash", "-c", steps.join("; ")], { stdio: "inherit" });
		console.error("polygon: done. Check that your own Pi, Claude and Codex logins still work.");
		process.exit(login.status ?? 1);
	}
	const run = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const results = join(HERE, "results", run);
	mkdirSync(results, { recursive: true });
	rmSync(join(HERE, "results", "latest"), { force: true });
	symlinkSync(run, join(HERE, "results", "latest"));
	const kit = kitSource(results);
	const mounts = [`${kit}:/kit:${opts.kit === "clone" ? "rw" : "ro"}`, `${HERE}:/polygon:ro`, `${results}:/results`];
	// A worktree's node_modules is often a symlink out of the kit; mount its target at the same path.
	const modules = join(kit, "node_modules");
	try { if (lstatSync(modules).isSymbolicLink()) mounts.push(`${realpathSync(modules)}:${realpathSync(modules)}:ro`); } catch {}
	if (opts.live) {
		// The one serial refresher: it alone mounts the volume, and leaves the scenarios a copy with dead refresh tokens.
		const fresh = spawnSync("podman", ["run", "--rm", "--userns=keep-id", "-v", `${LOGIN_VOLUME}:/login:U`, "-v", `${HERE}:/polygon:ro`, "-v", `${results}:/results`,
			...LOGIN_ENV.flatMap((e) => ["-e", e]), "-e", "POLYGON_FRESHEN=1", "-w", "/tmp", image, "node", "/polygon/run.mjs"], { stdio: "inherit" });
		if (fresh.status !== 0) process.exit(fresh.status ?? 1);
	}
	const child = spawn("podman", ["run", "--rm", "--userns=keep-id", "--name", `polygon-${run}`,
		...mounts.flatMap((m) => ["-v", m]),
		"-e", "POLYGON_IN_CONTAINER=1", "-e", `POLYGON_RUN_ID=${run}`, "-e", `POLYGON_KIT_MODE=${opts.kit}`, ...(opts.live ? ["-e", "POLYGON_LIVE=1"] : []),
		image, "node", "/polygon/run.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
	child.on("exit", (code) => {
		rmSync(join(results, ".login"), { recursive: true, force: true });
		console.log(`polygon: results in ${join(HERE, "results", run)}`);
		process.exit(code ?? 1);
	});
}

const REFRESH_KEYS = new Set(["refresh", "refreshToken", "refresh_token"]);
const deadRefresh = (value) => Array.isArray(value) ? value.map(deadRefresh)
	: value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, REFRESH_KEYS.has(k) && typeof v === "string" ? "polygon-invalid-refresh-token" : deadRefresh(v)]))
	: value;

/** In the freshen container: refresh each login in the volume, then stage copies whose refresh tokens cannot rotate it. */
function freshen() {
	const present = LOGINS.filter((login) => existsSync(join("/login", login.files[0])));
	if (!present.some((login) => login.required)) {
		console.error(`polygon: the ${LOGIN_VOLUME} volume holds no Pi login${present.length ? "" : " (it is empty)"}. Run \`npm run polygon -- --login\` once and log in there; live runs never read your own ~/.pi, ~/.claude or ~/.codex.`);
		process.exit(3);
	}
	let spent = 0;
	for (const login of LOGINS) {
		if (!present.includes(login)) {
			console.error(`polygon: no ${login.name} login in ${LOGIN_VOLUME}; live scenarios that need it will fail.`);
			continue;
		}
		const done = spawnSync(login.argv[0], login.argv.slice(1), { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000, encoding: "utf8" });
		spent += login.requests;
		if (done.status === 0) continue;
		console.error(`polygon: freshening the ${login.name} login failed (${done.status ?? done.signal}): ${(done.stderr ?? "").trim().slice(-500)}`);
		if (login.required) process.exit(3);
	}
	for (const file of present.flatMap((login) => login.files).filter((f) => existsSync(join("/login", f)))) {
		mkdirSync(dirname(join("/results/.login", file)), { recursive: true });
		writeFileSync(join("/results/.login", file), JSON.stringify(deadRefresh(JSON.parse(readFileSync(join("/login", file), "utf8"))), null, 2), { mode: 0o600 });
	}
	writeFileSync("/results/freshen.json", JSON.stringify({ requests: spent, logins: present.map((login) => login.name) }, null, 2));
}

async function runOne(s, run) {
	const started = Date.now();
	const t = await sandbox({ run, name: s.name, kit: "/kit", results: "/results", logins: opts.live ? "/results/.login" : undefined });
	t.live = Boolean(opts.live);
	t.piRuntime = opts["pi-runtime"];
	let status = "pass", error;
	let timer, watch;
	// Real models think; a live scenario gets four times its puppet budget, but a refused login or a quota ends it at once.
	const timeoutMs = (s.timeoutMs ?? 90_000) * (opts.live ? 4 : 1);
	const refused = new Promise((_, reject) => {
		if (!t.live) return;
		watch = setInterval(() => {
			const hit = requests(t).find((r) => [401, 403, 429].includes(r.status));
			if (hit) reject(new Error(`a live ${hit.url} request got HTTP ${hit.status}${hit.status === 429 ? "" : "; run npm run polygon -- --login again if the polygon's login expired"}`));
		}, 1_000);
	});
	try {
		await Promise.race([s.run(t), refused, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`scenario timeout ${timeoutMs}ms`)), timeoutMs); })]);
	} catch (e) {
		status = "fail";
		error = e?.stack ?? String(e);
	} finally {
		clearTimeout(timer);
		clearInterval(watch);
	}
	const leaked = await t.teardown();
	if (status === "pass" && leaked.length) {
		status = "fail";
		error = `census: ${leaked.length} process(es) outlived the scenario: ${leaked.map((p) => p.argv.join(" ").slice(0, 120)).join(" | ")}`;
	}
	const result = { name: s.name, gate: s.gate, status, ms: Date.now() - started, error, leaked };
	if (t.live) {
		// The request guard: every live model request passed through the puppet's log with its upstream HTTP status.
		const sent = requests(t);
		result.requests = sent.length;
		if (sent.some((r) => r.status === 429)) result.status = "quota";
	}
	writeFileSync(join(t.dir, "result.json"), JSON.stringify(result, null, 2));
	return result;
}

async function inside() {
	const run = process.env.POLYGON_RUN_ID;
	const chosen = select(await scenarios());
	const selected = chosen.filter((s) => !isSkipped(s));
	if (process.env.POLYGON_KIT_MODE === "clone") {
		const install = spawnSync("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: "/kit", stdio: ["ignore", 2, 2], env: { ...process.env, npm_config_update_notifier: "false" } });
		if (install.status !== 0) process.exit(1);
	}
	const started = Date.now();
	const out = chosen.filter(isSkipped).map((s) => ({ name: s.name, gate: s.gate, status: "pending", ms: 0, error: s.pending }));
	let next = 0, stop;
	let spent = opts.live ? JSON.parse(readFileSync("/results/freshen.json", "utf8")).requests : 0;
	const maxRequests = Number(opts["max-requests"]);
	const workers = Math.min(selected.length, opts.live ? 4 : availableParallelism());
	await Promise.all(Array.from({ length: workers }, async () => {
		while (next < selected.length && !stop) {
			const result = await runOne(selected[next++], run);
			out.push(result);
			appendFileSync("/results/progress.log", `${result.status} ${result.name} ${result.ms}ms\n`);
			spent += result.requests ?? 0;
			if (result.status === "quota") stop ??= `quota: ${result.name} got HTTP 429`;
			else if (opts.live && spent >= maxRequests) stop ??= `request guard: ${spent} live requests reached --max-requests ${maxRequests}`;
		}
	}));
	out.push(...selected.slice(next).map((s) => ({ name: s.name, gate: s.gate, status: "skipped", ms: 0, error: stop })));
	out.sort((a, b) => a.name.localeCompare(b.name));
	writeFileSync("/results/summary.json", JSON.stringify({ run, kit: process.env.POLYGON_KIT_MODE, live: Boolean(opts.live), ...(opts.live ? { requests: spent } : {}), ms: Date.now() - started, results: out }, null, 2));
	console.log(`\n${"scenario".padEnd(24)} ${"gate".padEnd(8)} ${"status".padEnd(7)} ${"ms".padStart(7)}  detail`);
	for (const r of out) console.log(`${r.name.padEnd(24)} ${[r.gate].flat().join(",").padEnd(8)} ${(r.status === "pending" ? "PENDING" : r.status).padEnd(7)} ${String(r.ms).padStart(7)}  ${(r.error ?? "").split("\n")[0].slice(0, 140)}`);
	const count = (status) => out.filter((r) => r.status === status).length;
	const live = opts.live ? `, ${count("quota")} quota, ${count("skipped")} skipped; ${spent} live requests` : "";
	console.log(`\n${count("pass")} passed, ${count("fail")} failed, ${count("pending")} pending${live} in ${Date.now() - started}ms`);
	process.exit(count("fail") || count("quota") || count("skipped") || !selected.length ? 1 : 0);
}

await (process.env.POLYGON_FRESHEN ? freshen() : process.env.POLYGON_IN_CONTAINER ? inside() : host());
