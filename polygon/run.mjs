// Polygon runner. On the host it ensures the sandbox image and runs one container per polygon run;
// inside that container (POLYGON_IN_CONTAINER) it runs the scenarios in a worker pool and writes the summary.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sandbox } from "./sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const LOGIN_VOLUME = "pi-kit-polygon-login";
const { values: opts } = parseArgs({ options: {
	only: { type: "string" }, gate: { type: "string" }, slow: { type: "boolean" }, live: { type: "boolean" },
	list: { type: "boolean" }, login: { type: "boolean" }, kit: { type: "string", default: "." }, pi: { type: "string" },
} });

async function scenarios() {
	const dir = join(HERE, "scenarios");
	const files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
	return Promise.all(files.map(async (f) => (await import(pathToFileURL(join(dir, f)).href)).default));
}

function select(all) {
	const only = opts.only?.split(",");
	return all.filter((s) => (only ? only.includes(s.name) : !s.slow || opts.slow)
		&& (!opts.gate || [s.gate].flat().includes(opts.gate))
		&& (!opts.live || s.live));
}

function ensureImage() {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const args = { PI_VERSION: opts.pi ?? pkg.devDependencies["@earendil-works/pi-coding-agent"], CLAUDE_VERSION: "latest", CODEX_VERSION: "latest" };
	const containerfile = join(HERE, "Containerfile");
	// ponytail: "latest" is resolved once per tag; remove the image to pick up new Claude/Codex releases.
	const tag = createHash("sha256").update(readFileSync(containerfile)).update(JSON.stringify(args)).digest("hex").slice(0, 12);
	const image = `localhost/pi-kit-polygon:${tag}`;
	if (spawnSync("podman", ["image", "exists", image]).status === 0) return image;
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
		for (const s of await scenarios()) console.log(`${s.name.padEnd(24)} ${[s.gate].flat().join(",").padEnd(8)} ${[s.slow && "slow", s.live && "live"].filter(Boolean).join(" ")}`);
		return;
	}
	const image = ensureImage();
	if (opts.login) {
		console.error(`polygon: log in with pi (/login), claude and codex login; everything lands in the ${LOGIN_VOLUME} volume.`);
		const login = spawnSync("podman", ["run", "-it", "--rm", "--userns=keep-id", "-v", `${LOGIN_VOLUME}:/login:U`, "-e", "HOME=/login", "-w", "/login", image, "bash"], { stdio: "inherit" });
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
	if (opts.live) mounts.push(`${LOGIN_VOLUME}:/login:ro`);
	const child = spawn("podman", ["run", "--rm", "--userns=keep-id", "--name", `polygon-${run}`,
		...mounts.flatMap((m) => ["-v", m]),
		"-e", "POLYGON_IN_CONTAINER=1", "-e", `POLYGON_RUN_ID=${run}`, "-e", `POLYGON_KIT_MODE=${opts.kit}`,
		image, "node", "/polygon/run.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
	child.on("exit", (code) => {
		console.log(`polygon: results in ${join(HERE, "results", run)}`);
		process.exit(code ?? 1);
	});
}

async function runOne(s, run) {
	const started = Date.now();
	const t = await sandbox({ run, name: s.name, kit: "/kit", results: "/results" });
	t.live = Boolean(opts.live);
	let status = "pass", error;
	let timer;
	try {
		await Promise.race([s.run(t), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`scenario timeout ${s.timeoutMs ?? 90_000}ms`)), s.timeoutMs ?? 90_000); })]);
	} catch (e) {
		status = "fail";
		error = e?.stack ?? String(e);
	} finally {
		clearTimeout(timer);
	}
	const leaked = await t.teardown();
	if (status === "pass" && leaked.length) {
		status = "fail";
		error = `census: ${leaked.length} process(es) outlived the scenario: ${leaked.map((p) => p.argv.join(" ").slice(0, 120)).join(" | ")}`;
	}
	const result = { name: s.name, gate: s.gate, status, ms: Date.now() - started, error, leaked };
	writeFileSync(join(t.dir, "result.json"), JSON.stringify(result, null, 2));
	return result;
}

async function inside() {
	const run = process.env.POLYGON_RUN_ID;
	const selected = select(await scenarios());
	if (process.env.POLYGON_KIT_MODE === "clone") {
		const install = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: "/kit", stdio: ["ignore", 2, 2], env: { ...process.env, npm_config_update_notifier: "false" } });
		if (install.status !== 0) process.exit(1);
	}
	const started = Date.now();
	const out = [];
	let next = 0;
	const workers = Math.min(selected.length, opts.live ? 4 : availableParallelism());
	await Promise.all(Array.from({ length: workers }, async () => {
		while (next < selected.length) {
			const result = await runOne(selected[next++], run);
			out.push(result);
			appendFileSync("/results/progress.log", `${result.status} ${result.name} ${result.ms}ms\n`);
		}
	}));
	out.sort((a, b) => a.name.localeCompare(b.name));
	writeFileSync("/results/summary.json", JSON.stringify({ run, kit: process.env.POLYGON_KIT_MODE, live: Boolean(opts.live), ms: Date.now() - started, results: out }, null, 2));
	console.log(`\n${"scenario".padEnd(24)} ${"gate".padEnd(8)} ${"status".padEnd(6)} ${"ms".padStart(7)}  detail`);
	for (const r of out) console.log(`${r.name.padEnd(24)} ${[r.gate].flat().join(",").padEnd(8)} ${r.status.padEnd(6)} ${String(r.ms).padStart(7)}  ${(r.error ?? "").split("\n")[0].slice(0, 140)}`);
	const failed = out.filter((r) => r.status !== "pass").length;
	console.log(`\n${out.length - failed} passed, ${failed} failed in ${Date.now() - started}ms`);
	process.exit(failed || !out.length ? 1 : 0);
}

await (process.env.POLYGON_IN_CONTAINER ? inside() : host());
