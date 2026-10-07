import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, exec, pi, rpc, script } from "../drive.mjs";
import { runs } from "../look.mjs";

// Captures the full first request of each harness (puppet bodies.jsonl) for bench/context-wire; it asserts nothing about prose.
// Each capture is tagged by the next request's position: `phases` maps a label to the bodies.jsonl line range it produced.
const bodyCount = (t) => existsSync(join(t.dir, "bodies.jsonl")) ? readFileSync(join(t.dir, "bodies.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
const settings = (t) => join(t.agentDir, "settings.json");
const editJson = (file, edit) => writeFileSync(file, JSON.stringify(edit(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}), null, 2));
const once = (agent) => script({ agent, steps: [{ id: "x1", text: "ok" }] });

export default {
	name: "context-wire",
	gate: "bench",
	slow: true,
	live: true,
	bodies: true,
	timeoutMs: 240_000,
	async run(t) {
		const phases = {};
		const phase = async (label, fn) => {
			const from = bodyCount(t);
			try { await fn(); } catch (error) { phases[`${label}:error`] = String(error).slice(0, 400); }
			phases[label] = [from, bodyCount(t)];
		};
		const kitPackages = JSON.parse(readFileSync(settings(t), "utf8")).packages;

		await phase("pi-vanilla", async () => {
			editJson(settings(t), (s) => ({ ...s, packages: [] }));
			const run = await pi(t, ["--print", "--no-session", "--model", "polygon/puppet", once("pi-vanilla")]);
			if (run.status !== 0) throw new Error(run.stderr.slice(-400));
		});
		editJson(settings(t), (s) => ({ ...s, packages: kitPackages }));

		// User turn, the tool-result continuation, then a turn woken only by the job's task-notification; `verify` on, so the working rules are measured.
		editJson(join(t.agentDir, "pi-kit.json"), (k) => ({ ...k, verify: true }));
		await phase("pi-kit", async () => {
			const lead = rpc(t, { model: "polygon/puppet" });
			await lead.script({ agent: "pi-kit", steps: [
				{ id: "s1", tool: "job_start", args: { command: "sleep 1; echo polygon-ok", description: "probe" } },
				{ id: "s2", text: "started" },
				{ id: "s3", text: "woke" },
			] });
			await lead.until((_, events) => runs(events) >= 2, 60_000, "a lead run started by the finished job");
			await lead.until((_, events) => events.filter((e) => e.type === "agent_settled").length >= 2, 60_000, "the woken turn to settle");
			await lead.close();
		});

		await phase("claude-print", async () => {
			const run = await exec(t, "claude", ["-p", "--output-format", "json", once("claude-print")], { timeoutMs: 120_000 });
			writeFileSync(join(t.dir, "claude-print.json"), run.stdout);
		});

		// Interactive Claude needs a TTY; `script` gives it one. Onboarding, trust and the API-key prompt are pre-accepted.
		await phase("claude-interactive", async () => {
			const config = join(t.home, ".claude", ".claude.json");
			editJson(config, (c) => ({ ...c, hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: ["polygon"], rejected: [] },
				projects: { ...c.projects, [t.repo]: { ...c.projects?.[t.repo], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
			const from = bodyCount(t);
			const tui = exec(t, "script", ["-qfec", `claude '${once("claude-interactive")}'`, "/dev/null"], { timeoutMs: 60_000 });
			await eventually(() => readFileSync(join(t.dir, "bodies.jsonl"), "utf8").split("\n").filter(Boolean).slice(from)
				.some((line) => (JSON.parse(line).body.tools ?? []).length > 5), 45_000, "an interactive Claude request with its tools");
			await exec(t, "pkill", ["-KILL", "-f", "claude-interactive"]);
			await tui;
		});

		// Codex on its built-in default model, served by the puppet (offline only: live Codex goes to ChatGPT uncounted).
		if (!t.live) await phase("codex-exec", async () => {
			const toml = join(t.home, ".codex", "config.toml");
			writeFileSync(toml, readFileSync(toml, "utf8").replace('model = "puppet"\n', ""));
			const run = await exec(t, "codex", ["exec", "--skip-git-repo-check", once("codex-exec")], { timeoutMs: 120_000 });
			if (run.status !== 0) phases["codex-exec:stderr"] = run.stderr.slice(-400);
		});

		writeFileSync(join(t.dir, "phases.json"), JSON.stringify(phases, null, 2));
	},
};
