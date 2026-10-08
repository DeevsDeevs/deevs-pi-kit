import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventually, fixtureModels, herdr, rpc, sleep } from "../drive.mjs";
import { dialogs, entries, notifications, procs, toolCalls } from "../look.mjs";

// Eight collaborators (three Claude Code, three Codex, two Pi) work one fixture repo at once and talk to the lead and to
// each other while it stands one down, is killed with -9 and reopens with --continue, resumes the stood-down one, relays
// one Pi collaborator's finding to the other and winds the swarm down. Every message must arrive exactly once.
// The same file runs on the puppet (scripts in the messages) and on --live (real tasks); results.json holds the report.
const T = (mod, fn, call, want) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${fn} } from "../src/${mod}.js";\ntest("${fn}", () => assert.equal(${call}, ${JSON.stringify(want)}));\n`;
const FILES = {
	"package.json": '{"type":"module","scripts":{"test":"node --test"}}\n',
	"src/slugify.js": 'export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");\n',
	"test/slugify.test.js": T("slugify", "slugify", 'slugify(" Hello, World! ")', "hello-world"),
	"src/money.js": "export const formatCents = (c) => `$${(c / 100).toFixed(2)}`;\n",
	"test/money.test.js": T("money", "formatCents", "formatCents(-150)", "-$1.50"),
	"src/duration.js": 'export function parseDuration(text) {\n\tthrow new Error("TODO");\n}\n',
	"test/duration.test.js": T("duration", "parseDuration", 'parseDuration("1h30m")', 5400),
	"src/stats.js": "export const median = (xs) => {\n\tconst s = [...xs].sort();\n\tconst m = s.length >> 1;\n\treturn s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n};\n",
	"src/cli.js": 'const items = process.argv.slice(2);\nconsole.log(`${items.length} items`);\n',
	// node tools/png.mjs out.png 3 1: one green bar per number.
	"tools/png.mjs": `import { writeFileSync } from "node:fs";\nimport { crc32, deflateSync } from "node:zlib";\nconst [out, ...bars] = process.argv.slice(2);\nconst w = bars.length * 10, h = 10 * Math.max(1, ...bars.map(Number)), row = w * 3 + 1, px = Buffer.alloc(row * h);\nfor (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (h - y <= 10 * Number(bars[Math.floor(x / 10)])) px[y * row + 2 + x * 3] = 200;\nconst chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(data.length); c.writeUInt32BE(crc32(body)); return Buffer.concat([n, body, c]); };\nconst ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;\nwriteFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]));\n`,
};
const SH = { "claude-code": (c) => ({ tool: "Bash", args: { command: c } }), codex: (c) => ({ tool: "exec_command", args: { cmd: c } }), pi: (c) => ({ tool: "bash", args: { command: c } }) };
const SM = { "claude-code": "~__SendMessage", codex: "~SendMessage", pi: "SendMessage" };
const COMMIT = (who) => `echo ${who} >> README.md && git commit -qam ${who} && git rev-parse HEAD`;
const nonce = () => `[m:${randomBytes(4).toString("hex")}]`;
const users = (file) => readFileSync(file, "utf8").split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const files = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
// Kit bugs this scenario confirms that the kit has not fixed yet: report.json lists each hit under `known`; they never fail a run.
const KNOWN = {
	K2: "a Claude or Codex turn too short for Herdr's state count and with no SendMessage gets the same wake prompt again, up to 3 times 30 s apart",
};
const pct = (xs, p) => xs.length ? xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : null;

export default {
	name: "collab-swarm",
	gate: "M6",
	live: true,
	timing: true,
	// Eight real collaborators, a kill -9 and a resume: the run takes minutes even when every stand-down is quick.
	slow: true,
	timeoutMs: 1_200_000,
	async run(t) {
		const { cli } = await herdr(t);
		for (const [path, body] of Object.entries(FILES)) { mkdirSync(dirname(join(t.repo, path)), { recursive: true }); writeFileSync(join(t.repo, path), body); }
		t.git("add", "."); t.git("commit", "-qm", "swarm fixture");
		const claudeConfig = join(t.home, ".claude", ".claude.json");
		const seeded = t.live && existsSync(claudeConfig) ? JSON.parse(readFileSync(claudeConfig, "utf8")) : { hasCompletedOnboarding: true, customApiKeyResponses: { approved: ["polygon"], rejected: [] } };
		writeFileSync(claudeConfig, JSON.stringify({ ...seeded, projects: { ...seeded.projects, [t.repo]: { ...seeded.projects?.[t.repo], hasTrustDialogAccepted: true } } }));
		if (!t.live) {
			fixtureModels(t, "polygon", ["pi-cli", "pi-ask"]);
			const models = JSON.parse(readFileSync(join(t.agentDir, "models.json"), "utf8"));
			models.providers.polygon.models[0].input = ["text", "image"];
			writeFileSync(join(t.agentDir, "models.json"), JSON.stringify(models, null, 2));
		}
		const codex = t.live ? "codex:" : "codex:puppet";
		// One nonce per lead message, an id to find it in transcripts; the puppet scripts gate on them, so they come first.
		const m = {};
		const SWARM = [
			{ name: "cc-fix", model: "claude:opus", profile: "workspace-write", driver: "claude-code" },
			{ name: "cc-review", model: "claude:opus", profile: "read-only", driver: "claude-code" },
			{ name: "cc-image", model: "claude:opus", profile: "workspace-write", driver: "claude-code" },
			{ name: "cx-duration", model: codex, profile: "workspace-write", driver: "codex" },
			{ name: "cx-money", model: codex, profile: "workspace-write", driver: "codex" },
			{ name: "cx-audit", model: codex, profile: "read-only", driver: "codex" },
			{ name: "pi-cli", model: t.live ? "sol" : "polygon/pi-cli", profile: "workspace-write", driver: "pi" },
			{ name: "pi-ask", model: t.live ? "anthropic/claude-opus-5-5" : "polygon/pi-ask", profile: "read-only", driver: "pi" },
		];
		const kind = Object.fromEntries(SWARM.map((c) => [c.name, c.driver]));
		const sh = (name, id, c, extra) => ({ id, ...SH[kind[name]](c), ...extra });
		const say = (name, id, to, message, extra, images) => ({ id, tool: SM[kind[name]], args: { to, message, ...(images && { images }) }, ...extra });
		for (const c of SWARM) for (const k of ["task", "follow", "resume", "relay"]) m[`${c.name}/${k}`] = nonce();
		// A gate must not match the script that holds it: its quotes are escaped there, so it opens only on the message itself.
		const gate = (name, k) => `${k}-mark "${m[`${name}/${k}`]}"`;
		const noted = (name) => [sh(name, "f1", "sleep 2", { on: gate(name, "follow") }), { id: "f2", then: true, text: "noted" }];
		const FINDING = 'review "finding"';
		const PUPPET = {
			"cc-fix": [sh("cc-fix", "a1", COMMIT("cc-fix")), say("cc-fix", "a2", "main", "cc-fix-1"), { id: "a3", text: "done" },
				sh("cc-fix", "b1", "sleep 8", { on: gate("cc-fix", "follow") }), say("cc-fix", "b2", "main", "cc-fix-2", { then: true }), { id: "b3", then: true, text: "done" },
				say("cc-fix", "c1", "main", "cc-fix-3", { on: gate("cc-fix", "resume") }), { id: "c2", then: true, text: "done" }],
			"cc-review": [say("cc-review", "r1", "cx-money", FINDING), { id: "r2", text: "waiting" },
				say("cc-review", "r3", "main", "review-verdict", { on: "money-sha" }), { id: "r4", then: true, text: "done" }, ...noted("cc-review")],
			"cc-image": [sh("cc-image", "i1", 'node tools/png.mjs "$PWD/tests.png" 3 1 && echo "$PWD/tests.png"'),
				say("cc-image", "i2", "main", "cc-image-1", {}, ["$/\\/results\\/\\S*tests\\.png/"]), { id: "i3", text: "done" }, ...noted("cc-image")],
			// cx-duration answers its follow-up at once and without idleMs, the K2 probe.
			"cx-duration": [sh("cx-duration", "d1", COMMIT("cx-duration")), say("cx-duration", "d2", "main", "duration-1"), { id: "d3", text: "done" }],
			"cx-money": [sh("cx-money", "n1", COMMIT("cx-money"), { on: FINDING }), say("cx-money", "n2", "cc-review", "money-sha", { then: true }),
				say("cx-money", "n3", "main", "money-1", { then: true }), { id: "n4", then: true, text: "done" }, ...noted("cx-money")],
			"cx-audit": [sh("cx-audit", "x1", "grep -n export src/*.js"), say("cx-audit", "x2", "main", "audit-1"), { id: "x3", text: "done" },
				sh("cx-audit", "x4", "sleep 9", { on: gate("cx-audit", "follow") }), say("cx-audit", "x5", "main", "audit-2", { then: true }), { id: "x6", then: true, text: "done" }],
			"pi-cli": [sh("pi-cli", "p1", COMMIT("pi-cli")), say("pi-cli", "p2", "main", "cli-1"), { id: "p3", text: "done" },
				sh("pi-cli", "p4", "sleep 20", { on: gate("pi-cli", "follow") }), say("pi-cli", "p5", "main", "cli-2", { then: true }), { id: "p6", then: true, text: "done" },
				say("pi-cli", "p7", "main", "cli-3", { on: gate("pi-cli", "relay") }), { id: "p8", then: true, text: "done" }],
			"pi-ask": [say("pi-ask", "q1", "pi-cli", "stats-finding"), say("pi-ask", "q2", "main", "ask-1"), { id: "q3", text: "done" }],
		};
		const LIVE = {
			"cc-fix": ["Fix src/slugify.js so leading and trailing dashes are trimmed (npm test shows the failure). Commit it and SendMessage main the commit sha.", "Also collapse runs of dashes into one and add a test for it; commit and report the new sha to main.", "Report your final commit sha to main."],
			"cc-review": ["Review src/money.js formatCents for negative amounts; do not edit files. Send your finding directly to the collaborator named cx-money with SendMessage (to: \"cx-money\"): it fixes the code and replies to you with a commit sha. When that reply arrives, inspect the commit with git show <sha> and SendMessage main a one-line verdict.", "Also check that formatCents(0) gives $0.00 and include that in your verdict to main."],
			"cc-image": ["Run npm test. Then run node tools/png.mjs \"$PWD/tests.png\" <passed> <failed> with the counts, and SendMessage main a one-line summary with images set to the absolute path of that tests.png.", "Include the total number of tests in your summary to main."],
			"cx-duration": ["Implement parseDuration in src/duration.js so that \"1h30m\" gives 5400 seconds (see test/duration.test.js). Commit it and SendMessage main the commit sha.", "Also accept \"45s\" and \"2h\"; commit and report to main."],
			"cx-money": ["The collaborator cc-review will send you a finding about src/money.js; it arrives by itself as a message once you end your turn, so end your turn until it does. Then fix src/money.js, commit, SendMessage cc-review (to: \"cc-review\") the commit sha, and SendMessage main the sha too.", "Also make sure formatCents(0) gives $0.00."],
			"cx-audit": ["List the exported functions in src/ that have no test in test/, with file:line, and SendMessage main the list. Do not edit anything.", "Also say which test files fail under npm test right now, in a second SendMessage to main."],
			"pi-cli": ["Add a --json flag to src/cli.js that prints {\"items\":N} instead of \"N items\". Commit it and SendMessage main the commit sha.", "Also add a test for --json in test/cli.test.js; commit and report to main.", null],
			"pi-ask": ["Find the bug in src/stats.js; do not edit files. First try SendMessage to pi-cli (to: \"pi-cli\") with your finding; whatever happens, then SendMessage main your finding and say whether the message to pi-cli went through.", "When you are done, also tell main how many functions src/stats.js exports."],
		};
		const text = (name, k, i) => `${LIVE[name][i]} ${m[`${name}/${k}`]}`;
		const task = (name) => t.live ? text(name, "task", 0) : `POLYGON ${JSON.stringify({ agent: name, ...(name !== "cx-duration" && { idleMs: 2_000 }), steps: PUPPET[name] })} ${m[`${name}/task`]}`;
		const follow = (name) => t.live ? text(name, "follow", 1) : gate(name, "follow");
		const relay = t.live ? `pi-ask, a read-only collaborator, reported a bug in src/stats.js median(). Fix it, commit, and SendMessage main the sha. Its report: see your repo's src/stats.js; median sorts numbers as strings. ${m["pi-cli/relay"]}` : gate("pi-cli", "relay");
		const resume = t.live ? text("cc-fix", "resume", 2) : gate("cc-fix", "resume");
		const writers = SWARM.filter((c) => c.profile === "workspace-write").map((c) => c.name);
		const steps = {
			start: [{ id: "l-start", tool: "collaborator_start", args: { participants: SWARM.map(({ name, model, profile }) => ({ name, model, profile })) } }],
			tasks: [...SWARM.map((c) => ({ id: `l-task-${c.name}`, tool: "SendMessage", args: { to: c.name, message: task(c.name) } })), { id: "l-list-1", tool: "ListAgents", args: {} }],
			follow: SWARM.map((c) => ({ id: `l-follow-${c.name}`, tool: "SendMessage", args: { to: c.name, message: follow(c.name) } })),
			stop: [{ id: "l-stop-cc-fix", tool: "TaskStop", args: { task_id: "cc-fix" } }],
			roster: [{ id: "l-list-2", tool: "ListAgents", args: {} }],
			resume: [{ id: "l-resume", tool: "SendMessage", args: { to: "cc-fix", message: resume } }],
			relay: [{ id: "l-relay", tool: "SendMessage", args: { to: "pi-cli", message: relay } }],
			down: SWARM.map((c) => ({ id: `l-down-${c.name}`, tool: "TaskStop", args: { task_id: c.name } })),
			clean: [{ id: "l-worktrees", tool: "collaborator_workspace", args: { action: "list" } }, ...writers.map((name) => ({ id: `l-clean-${name}`, tool: "collaborator_workspace", args: { action: "cleanup", name, discard: true } })), { id: "l-list-3", tool: "ListAgents", args: {} }],
		};
		for (const [name, list] of Object.entries(steps)) list.push({ id: `l-${name}-end`, text: name });
		// On the puppet every phase sits in the first script, its first step gated on the phase prompt and the rest chained.
		const puppet = Object.entries(steps).flatMap(([name, list]) => list.map((s, i) => name === "start" ? s : i === 0 ? { ...s, on: `[phase:${name}]` } : { ...s, then: true }));
		const lead = rpc(t);
		const report = { known: {}, findings: {}, phases: {}, stats: [] };
		// A failed kit check is recorded and the swarm goes on, so one run reports every failure; the run fails at its end.
		const bugs = [];
		const check = (ok, message, known) => { if (!ok) (known ? (report.known[known] ??= [KNOWN[known]]) : bugs).push(message); };
		const save = () => writeFileSync(join(t.dir, "report.json"), JSON.stringify(report, null, 2));
		const phase = async (name, ms = 120_000) => {
			const from = lead.events.length, at = Date.now();
			const want = steps[name].filter((s) => s.tool).map((s) => s.tool);
			const count = (list, tool) => list.filter((x) => x === tool).length;
			await (t.live ? lead.script({ agent: "lead", steps: steps[name] }) : name === "start" ? lead.script({ agent: "lead", steps: puppet }) : lead.prompt(`[phase:${name}]`));
			await lead.until((_, events) => want.every((tool) => count(toolCalls(events.slice(from)).map((c) => c.name), tool) >= count(want, tool)), ms, `phase ${name}`);
			const calls = toolCalls(lead.events.slice(from));
			// How many tool calls the lead made per message: a live model may call a phase's steps together.
			const together = Math.max(0, ...lead.events.slice(from).filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => e.message.content.filter((b) => b.type === "toolCall").length));
			report.phases[name] = { ms: Date.now() - at, together, calls: calls.map((c) => ({ name: c.name, isError: c.isError, text: c.isError ? c.text.slice(0, 300) : undefined })) };
			save();
			return calls;
		};
		const stats = async (label) => { try { report.stats.push({ label, ...(await lead.send({ type: "get_session_stats" })).data }); } catch {} };
		const state = () => { try { return JSON.parse(readFileSync(join(t.agentDir, "runtime", "state.v1.json"), "utf8")); } catch { return { participants: {}, events: {} }; } };
		const mail = () => { const s = state(); const who = (k) => s.participants[k]?.participantId; return Object.values(s.events).map((e) => ({ id: e.eventId, from: who(e.source.id), to: who(e.recipientParticipantKey), body: e.body, createdAt: e.createdAt, readAt: e.readAt })); };
		const statuses = async () => {
			const [tabs, agents] = await Promise.all([cli("tab", "list"), cli("agent", "list")]);
			return Object.fromEntries(agents.agents.map((a) => [tabs.tabs.find((tab) => tab.tab_id === a.tab_id)?.label?.replace("collaborator:", "") ?? a.name, a.agent_status]));
		};
		const samples = [];
		const sampler = setInterval(() => statuses().then((s) => samples.push({ at: Date.now(), s })).catch(() => {}), 2_000);
		t.closers.push(async () => { clearInterval(sampler); writeFileSync(join(t.dir, "status.jsonl"), samples.map((x) => JSON.stringify(x)).join("\n") + "\n"); });
		// A provider error anywhere (the lead, a Pi collaborator, a Claude or Codex transcript) stops the run for a human to read.
		const providerError = () => {
			const lead1 = lead.events.find((e) => e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error");
			if (lead1) return `lead: ${lead1.message.errorMessage}`;
			for (const f of files(join(t.agentDir, "runtime", "collaborator-sessions"))) for (const e of users(f)) if (e.message?.stopReason === "error") return `${f}: ${e.message.errorMessage}`;
			for (const f of files(join(t.home, ".claude", "projects"))) for (const e of users(f)) if (e.isApiErrorMessage) return `${f}: ${JSON.stringify(e.message?.content).slice(0, 400)}`;
			for (const f of files(join(t.home, ".codex", "sessions"))) for (const e of users(f)) if ((e.type === "event_msg" && e.payload?.type === "error") || Object.values(e.payload?.rate_limits ?? {}).some((r) => r?.used_percent >= 100)) return `${f}: ${JSON.stringify(e.payload).slice(0, 400)}`;
		};
		let quotaTimer;
		const quota = new Promise((_, reject) => { quotaTimer = setInterval(() => { const hit = providerError(); if (hit) { writeFileSync(join(t.dir, "quota.txt"), hit); reject(new Error(`provider error, stopping: ${hit.slice(0, 300)}`)); } }, 3_000); });
		t.closers.push(async () => clearInterval(quotaTimer));
		quota.catch(() => {});
		let verified = false;
		try { await Promise.race([swarm(), quota]); } finally {
			// A run cut short still writes its delivery report.
			if (!verified) try { verify(mail()); } catch (e) { report.verifyError = String(e.message).slice(0, 2000); }
			save();
		}

		async function swarm() {
			const [start] = await phase("start", 240_000);
			writeFileSync(join(t.dir, "start.json"), JSON.stringify(start, null, 2));
			assert.equal(start.isError, false, start.text);
			assert.deepEqual(start.details.results.map((r) => r.status), SWARM.map(() => "started"), start.text);
			const roster = (call) => Object.fromEntries([...call.text.matchAll(/^collaborator\s+(\S+) \(\S+\) (running|completed) · (pi|claude-code|codex) (read-only|workspace-write)/gm)].map(([, n, ...rest]) => [n, rest.join(" ")]));
			const rosterCheck = (label, call, status) => {
				const got = roster(call);
				for (const c of SWARM) {
					const want = `${status(c.name)} ${c.driver} ${c.profile}`;
					check(got[c.name] === want, `${label}: ${c.name} is ${got[c.name]}, want ${want}`);
				}
			};
			const sent = await phase("tasks", 180_000);
			assert.ok(sent.filter((c) => c.name === "SendMessage").every((c) => !c.isError), "a task send failed");
			rosterCheck("roster after start", sent.find((c) => c.name === "ListAgents"), () => "running");
			await stats("tasks");
			const byNonce = (k, name) => mail().find((e) => e.from === "main" && e.to === name && e.body.includes(m[`${name}/${k}`]));
			await eventually(() => SWARM.every((c) => byNonce("task", c.name)?.readAt), 120_000, "every task read");
			if (t.live) await eventually(async () => Object.values(await statuses()).filter((s) => s === "working").length >= 4, 60_000, "four collaborators working").catch(() => {});
			await phase("follow");
			await eventually(() => byNonce("follow", "cc-fix")?.readAt, 60_000, "cc-fix reading its follow-up");
			await sleep(t.live ? 15_000 : 1_000);
			const [stop] = await phase("stop", 200_000);
			check(!stop.isError, `TaskStop cc-fix: ${stop.text}`);
			check(!(await cli("tab", "list")).tabs.some((tab) => tab.label === "collaborator:cc-fix"), "cc-fix's tab outlived its stand-down");
			await stats("stood-down");
			if (t.live) await eventually(async () => Object.values(await statuses()).filter((s) => s === "working").length >= 3, 30_000, "three working").catch(() => {});
			const deliveredBefore = new Set(notifications(lead.events).filter((n) => n.customType === "collaborator-message").flatMap((n) => n.details.eventIds));
			await lead.kill9();
			const killedAt = Date.now(), cap = killedAt + (t.live ? 180_000 : 60_000);
			while (Date.now() < cap && (Date.now() - killedAt < 35_000 || mail().filter((e) => e.to === "main" && e.createdAt > killedAt).length < (t.live ? 2 : 1))) await sleep(1_000);
			const reopenFrom = lead.events.length, reopenedAt = Date.now();
			const dead = mail().filter((e) => e.to === "main" && !deliveredBefore.has(e.id) && e.createdAt < reopenedAt).map((e) => e.id);
			report.phases.kill9 = { ms: reopenedAt - killedAt, sentWhileDead: mail().filter((e) => e.to === "main" && e.createdAt > killedAt).length, pendingAtReopen: dead.length };
			await lead.restart(["--continue"]);
			if (dead.length) {
				const first = await lead.until((e, events) => events.indexOf(e) >= reopenFrom && e.type === "message_end" && e.message?.customType === "collaborator-message", 60_000, "the held mail on reopen");
				check(dead.every((id) => first.message.details.eventIds.includes(id)), "the first delivery after reopen missed mail sent while the lead was dead");
			}
			rosterCheck("roster after reopen", (await phase("roster"))[0], (n) => n === "cc-fix" ? "completed" : "running");
			await stats("reopened");
			const resumedAt = Date.now();
			const [resumed] = await phase("resume", 240_000);
			check(!resumed.isError, `resuming cc-fix: ${resumed.text}`);
			await eventually(() => mail().some((e) => e.from === "cc-fix" && e.to === "main" && e.createdAt > resumedAt), 120_000, "the resumed cc-fix's report").catch((e) => check(false, e.message));
			check((await cli("tab", "list")).tabs.filter((tab) => tab.label === "collaborator:cc-fix").length === 1, "the resumed cc-fix has other than one tab");
			report.findings.resumeArgv = procs(t).filter((p) => p.argv.some((a) => a.includes("claude")) && p.argv.includes("--resume")).map((p) => p.argv.slice(0, 4).join(" "));
			check(report.findings.resumeArgv.length > 0, "no claude --resume process after the resume");
			await eventually(() => mail().some((e) => e.from === "pi-ask" && e.to === "main"), 120_000, "pi-ask's report");
			const relayedAt = Date.now();
			await phase("relay");
			await eventually(() => mail().some((e) => e.from === "pi-cli" && e.to === "main" && e.createdAt > relayedAt), 120_000, "pi-cli's answer to the relay").catch((e) => { report.findings.relay = String(e.message); });
			// Let the swarm finish: nobody working for two samples, and the lead holds all its mail.
			await eventually(() => samples.length > 2 && samples.slice(-2).every((x) => !Object.values(x.s).includes("working")) && mail().filter((e) => e.to === "main").every((e) => e.readAt), 60_000, "the swarm to go quiet").catch((e) => { report.findings.quiet = String(e.message); });
			await stats("quiet");
			const down = await phase("down", 1_200_000);
			const stopMs = lead.events.filter((e) => e.type === "tool_execution_end" && e.toolName === "TaskStop").map((e) => [e.toolCallId, e.receivedAt - lead.events.find((x) => x.type === "tool_execution_start" && x.toolCallId === e.toolCallId)?.receivedAt]);
			report.findings.stopMs = stopMs;
						// cx-duration, the K2 probe, holds its follow-up unconfirmed until its third prompt counts it read.
			for (const [id, ms] of stopMs) check(ms < (t.live ? 100_000 : 20_000), `TaskStop ${id} took ${ms} ms`, id === "l-down-cx-duration" ? "K2" : undefined);
			const busy = down.filter((c) => c.name === "TaskStop" && c.isError);
			report.findings.F2 = { together: report.phases.down.together, errors: busy.map((c) => c.text.slice(0, 200)) };
			// A live lead may call the stops together; each one that lost the lifecycle race is retried alone (live only: the puppet's scripts are fixed).
			if (t.live) for (const c of SWARM) if ((await statuses())[c.name]) {
				steps[`down-${c.name}`] = [{ id: `l-redown-${c.name}`, tool: "TaskStop", args: { task_id: c.name } }, { id: `l-redown-${c.name}-end`, text: "ok" }];
				await phase(`down-${c.name}`, 200_000);
			}
			if (!t.live) check(busy.length === 0, `a stand-down failed: ${busy.map((c) => c.text).join(" | ")}`);
			report.branches = Object.fromEntries(writers.map((name) => [name, t.git("log", "--format=%h %s", `main..runtime/collab/collab/${name}`).trim().split("\n").filter(Boolean)]));
			const final = mail();
			writeFileSync(join(t.dir, "mail.json"), JSON.stringify(final, null, 2));
			const clean = await phase("clean", 180_000);
			check(clean.every((c) => !c.isError), `a cleanup failed: ${clean.filter((c) => c.isError).map((c) => c.text).join(" | ")}`);
			// Every writer committed or, on Codex, could not: none of their worktrees is clean or merged.
			report.worktrees = Object.fromEntries((clean.find((c) => c.details?.worktrees)?.details.worktrees ?? []).map((w) => [w.participantId, { uncommitted: w.uncommitted, ahead: w.ahead }]));
			check(writers.every((name) => report.worktrees[name]?.uncommitted + report.worktrees[name]?.ahead > 0), `the list hides a writer's work: ${JSON.stringify(report.worktrees)}`);
			rosterCheck("roster after wind-down", clean.find((c) => c.name === "ListAgents"), () => "completed");
			await stats("end");
			const swarmProcs = () => [...procs(t).filter((p) => p.argv.some((a) => /claude|codex|runtime\/mcp\/main\.mjs/.test(a))), ...procs(t, "PI_RUNTIME_COLLABORATE=")];
			await eventually(() => swarmProcs().length === 0, 15_000, "the swarm's processes to exit").catch(() => {});
			check(swarmProcs().length === 0, `collaborator processes outlived the wind-down: ${swarmProcs().map((p) => p.argv.slice(0, 3).join(" ")).join(" | ")}`);
			check(t.git("worktree", "list").trim().split("\n").length === 1, "a collaborator worktree is left");
			check(t.git("branch", "--list", "runtime/collab/*").trim() === "", "a collaborator branch is left");
			verify(final);
		}

		function verify(final) {
			verified = true;
			// The lead: every message to main is in exactly one collaborator-message entry of its session, across both lives.
			const leadHeld = entries(t).filter((e) => e.type === "custom_message" && e.customType === "collaborator-message").flatMap((e) => e.details.eventIds);
			const toMain = final.filter((e) => e.to === "main");
			const twice = (ids) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
			const rpcSeen = notifications(lead.events).filter((n) => n.customType === "collaborator-message").flatMap((n) => n.details.eventIds);
			// Natives: the wake line as typed; Pi collaborators: their session's collaborator-message entries.
			const piHeld = files(join(t.agentDir, "runtime", "collaborator-sessions")).flatMap((f) => users(f).filter((e) => e.type === "custom_message" && e.customType === "collaborator-message").map((e) => ({ ids: e.details.eventIds, at: Date.parse(e.timestamp) })));
			const transcripts = [...files(join(t.home, ".claude", "projects")), ...files(join(t.home, ".codex", "sessions"))].map((f) => users(f).flatMap((e) => {
				if (e.type === "user" && e.message) return [typeof e.message.content === "string" ? e.message.content : e.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")];
				if (e.type === "response_item" && e.payload?.type === "message" && e.payload.role === "user") return [e.payload.content.map((b) => b.text ?? "").join("\n")];
				return [];
			}));
			const lines = final.filter((e) => e.to !== "main").map((e) => {
				if (kind[e.to] === "pi") { const hits = piHeld.filter((h) => h.ids.includes(e.id)); return { ...e, copies: hits.length, deliveredAt: hits[0]?.at }; }
				const needle = `Message from ${e.from}: ${e.body.replace(/\s+/gu, " ").trim()}`.slice(0, 80);
				return { ...e, copies: Math.max(0, ...transcripts.map((ts) => ts.filter((x) => x.includes(needle)).length)), deliveredAt: e.readAt };
			});
			const leadLines = toMain.map((e) => ({ ...e, copies: leadHeld.filter((id) => id === e.id).length, deliveredAt: lead.events.find((x) => x.type === "message_end" && x.message?.details?.eventIds?.includes(e.id))?.receivedAt }));
			const all = [...leadLines, ...lines].map(({ body, ...e }) => ({ ...e, kind: e.to === "main" ? "lead" : kind[e.to], body: body.slice(0, 120), latencyMs: e.deliveredAt ? e.deliveredAt - e.createdAt : null }));
			writeFileSync(join(t.dir, "deliveries.json"), JSON.stringify(all, null, 2));
			report.latency = Object.fromEntries(["lead", "pi", "claude-code", "codex"].map((k) => { const xs = all.filter((e) => e.kind === k && e.latencyMs !== null).map((e) => e.latencyMs); return [k, { n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Math.max(...xs) : null }]; }));
			report.coalescing = { eventsToMain: toMain.length, leadDeliveries: entries(t).filter((e) => e.type === "custom_message" && e.customType === "collaborator-message").length };
			report.rpcRedelivered = twice(rpcSeen);
			report.pairs = Object.fromEntries(["cc-review>cx-money", "cx-money>cc-review", "pi-ask>pi-cli", "main>pi-cli"].map((p) => [p, final.filter((e) => `${e.from}>${e.to}` === p).length]));
			const askSession = files(join(t.agentDir, "runtime", "collaborator-sessions")).find((f) => f.includes("__collab__pi-ask"));
			const askCalls = askSession ? users(askSession).flatMap((e) => e.message?.content?.filter?.((b) => b.type === "toolCall" && b.name === "SendMessage" && b.arguments?.to === "pi-cli") ?? []) : [];
			const askResults = askSession ? users(askSession).filter((e) => e.message?.role === "toolResult" && askCalls.some((c) => c.id === e.message.toolCallId)) : [];
			report.findings.F1 = { piToPeerCalls: askCalls.length, errors: askResults.filter((e) => e.message.isError).map((e) => e.message.content?.[0]?.text?.slice(0, 200)) };
			const imageEvents = toMain.filter((e) => e.from === "cc-image" && /<image>\/[^<]+\.png<\/image>/.test(e.body));
			report.findings.image = { tagged: imageEvents.length, relative: toMain.filter((e) => /<image>[^/<][^<]*<\/image>/.test(e.body)).length, atLead: imageEvents.filter((e) => lead.events.some((x) => x.type === "message_end" && x.message?.details?.eventIds?.includes(e.id) && x.message.content.some((b) => b.type === "image"))).length };
			report.compactions = entries(t).filter((e) => e.type === "compaction").length;
			report.blocked = samples.filter((x) => Object.values(x.s).includes("blocked")).map((x) => x.s);
			save();
			for (const e of leadLines) check(e.copies === 1, `${e.from}>main reached the lead's session ${e.copies} times: ${e.body.slice(0, 60)}`);
			for (const e of lines.filter((x) => x.readAt)) check(e.copies === 1, `${e.from}>${e.to} arrived ${e.copies} times: ${e.body.slice(0, 60)}`, e.copies > 1 && kind[e.to] !== "pi" ? "K2" : undefined);
			for (const e of final.filter((x) => x.to === "main" && !x.readAt)) check(false, `${e.from}>main left unread: ${e.body.slice(0, 60)}`);
			report.unreadByCollaborators = final.filter((e) => e.to !== "main" && !e.readAt).map((e) => `${e.from}>${e.to}: ${e.body.slice(0, 60)}`);
			check(report.findings.image.tagged === report.findings.image.atLead, "an image sent by absolute path did not reach the lead as an image");
			if (report.findings.F1.errors.length) check(false, `pi-ask>pi-cli: ${report.findings.F1.errors[0]}`);
			if (!t.live) {
				check(report.pairs["cc-review>cx-money"] && report.pairs["cx-money>cc-review"], "the Claude and Codex peers did not message each other");
				check(report.pairs["pi-ask>pi-cli"] === 1, "the Pi peers did not message each other");
				check(report.findings.image.tagged === 1, "cc-image's image did not travel");
			}
			check(dialogs(lead.events) === 0, "a dialog reached the lead");
			check(notifications(lead.events).filter((n) => n.customType === "collaborator-notice").length === 0, "a blocked-tab notice reached the lead");
			check(report.blocked.length === 0, "a collaborator tab was blocked");
			check(report.compactions === 0, "the lead compacted");
			report.bugs = bugs;
			save();
			assert.deepEqual(bugs, [], "kit checks failed (report.json)");
		}
	},
};
