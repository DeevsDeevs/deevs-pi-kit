// One isolated world per scenario: its own HOME, agent dirs, fixture repo, puppet and process tag.
// Runs inside the polygon container; the env is built from scratch, so no host credential can leak in.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startPuppet } from "./puppet.mjs";
import { procs } from "./look.mjs";

/** The Pi logins a live lead can start on, in the order the kit's default `lead` (sol) prefers them. */
export const PI_LOGINS = ["openai", "openai-codex", "anthropic"];

/** Kit tools a lead gets once it reads their skill; a scenario starts with them unless it sets `deferred: true`. */
export const DEFERRED_TOOLS = ["job_start", "Monitor", "chain"];

/** `logins` (live runs only) is a staged copy of the polygon's logins, laid out like a HOME, refresh tokens already invalid. */
export async function sandbox({ run, name, kit, results, logins, bodies, deferred }) {
	const live = Boolean(logins);
	const dir = join(results, name);
	const home = join(dir, "home");
	const repo = join(dir, "repo");
	const agentDir = join(home, ".pi", "agent");
	for (const d of [agentDir, repo, join(home, "bin"), join(home, "tmp"), join(home, ".claude"), join(home, ".codex")]) mkdirSync(d, { recursive: true });
	const tag = `${run}/${name}`;
	const requestLog = join(dir, "requests.jsonl");
	writeFileSync(requestLog, "");
	const marks = [];
	const scripts = {};
	const { server, port } = await startPuppet(requestLog, marks, scripts, { live, bodies: bodies ? join(dir, "bodies.jsonl") : undefined });

	const env = {
		PATH: `${join(home, "bin")}:${process.env.PATH}`, LANG: "C.UTF-8", TERM: "xterm-256color", HOME: home,
		// Pi's extension loader caches transpiled files under the temp dir; a shared one lets concurrent boots read half-written files.
		TMPDIR: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
		PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
		PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, POLYGON_API_KEY: "polygon",
		DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
		GIT_CONFIG_NOSYSTEM: "1", POLYGON_RUN: tag,
		...(live ? {} : { PI_OFFLINE: "1", ANTHROPIC_API_KEY: "polygon" }),
	};
	writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = polygon\n\temail = polygon@invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
	// ponytail: a live `openai` lead (Sign in with ChatGPT) calls api.openai.com directly and skips the request log; Pi detects that
	// login by its stock baseUrl, so routing it through the puppet needs a forward that drops the fields the login rejects.
	const staged = live ? Object.keys(JSON.parse(readFileSync(join(logins, ".pi/agent/auth.json"), "utf8"))) : [];
	const model = live ? { defaultProvider: PI_LOGINS.find((p) => staged.includes(p)) } : { defaultProvider: "polygon", defaultModel: "puppet" };
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", ...model, packages: [kit], transport: "sse",
		...(!deferred && { defaultTools: DEFERRED_TOOLS.map((tool) => `+${tool}`) }) }, null, 2));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		polygon: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "polygon", models: [{ id: "puppet", contextWindow: 200000, maxTokens: 8000 }] },
		"openai-codex": { baseUrl: `http://127.0.0.1:${port}` }, anthropic: { baseUrl: `http://127.0.0.1:${port}` },
	} }, null, 2));
	if (live) cpSync(logins, home, { recursive: true });
	else {
		// Pi's built-in openai-codex reads the ChatGPT account from the OAuth access token's JWT claim.
		const jwt = [{ alg: "none" }, { "https://api.openai.com/auth": { chatgpt_account_id: "polygon" } }, "polygon"]
			.map((part) => Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url")).join(".");
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: jwt, refresh: "polygon", expires: 4102444800000, accountId: "polygon" } }, null, 2));
		writeFileSync(join(home, ".codex", "config.toml"), `model = "puppet"\nmodel_provider = "polygon"\n[model_providers.polygon]\nname = "polygon"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "POLYGON_API_KEY"\n`);
	}
	writeFileSync(join(repo, "README.md"), "fixture\n");
	const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
	git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");

	const t = { name, dir, home, repo, kit, agentDir, env, port, tag, requestLog, marks, scripts, git, closers: [] };
	t.teardown = async () => {
		for (const close of t.closers.reverse()) await close().catch(() => {});
		// A pane process Herdr's stop just killed can still be exiting under load once Herdr is gone; only what stays 3 s leaked.
		let leaked = procs(t);
		for (let i = 0; i < 30 && leaked.length; i++) { await new Promise((r) => setTimeout(r, 100)); leaked = procs(t); }
		for (const p of leaked) try { process.kill(p.pid, "SIGKILL"); } catch {}
		const closed = new Promise((r) => server.close(r));
		server.closeAllConnections();
		await closed;
		// Live access tokens stay out of the results the run leaves behind.
		if (live) for (const f of readdirSync(logins, { recursive: true, withFileTypes: true })) if (f.isFile()) rmSync(join(home, f.parentPath.slice(logins.length), f.name), { force: true });
		return leaked;
	};
	return t;
}
