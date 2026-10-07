// Chains checkpoint reminder for Claude Code and Codex, the same rule Pi applies:
// at 80% context the first stop is refused once with a reminder to save a Chain link,
// and after compaction the latest link is handed back so work continues from it.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CHECKPOINT_RATIO = 0.8;
const TAIL_BYTES = 512 * 1024;
const RESUME_BYTES = 16 * 1024;

/** Last known context use of the session: Codex rollouts report the window; Claude transcripts report usage only. */
function contextUse(transcriptPath) {
	if (!transcriptPath || !existsSync(transcriptPath)) return undefined;
	const lines = tail(transcriptPath).split("\n").reverse();
	for (const line of lines) {
		if (!line.startsWith("{")) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		const info = entry.type === "event_msg" && entry.payload?.type === "token_count" ? entry.payload.info : undefined;
		if (info?.last_token_usage && info.model_context_window) {
			return { used: info.last_token_usage.input_tokens ?? 0, window: info.model_context_window };
		}
		const usage = entry.type === "assistant" && !entry.isSidechain ? entry.message?.usage : undefined;
		if (usage) {
			const used = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
			return { used, window: claudeContextWindow(used) };
		}
	}
	return undefined;
}

// ponytail: Claude transcripts omit the window size, so it is inferred: an explicit override, then any use past 200k, then a [1m] model setting.
function claudeContextWindow(used) {
	const override = Number(process.env.CHAINS_CONTEXT_WINDOW);
	if (override > 0) return override;
	if (used > 200_000) return 1_000_000;
	const model = process.env.ANTHROPIC_MODEL ?? readJson(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"))?.model ?? "";
	return /\[1m\]/i.test(model) ? 1_000_000 : 200_000;
}

function tail(path) {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		return buffer.toString("utf8");
	} finally { closeSync(fd); }
}

function readJson(path) {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function stateFile(sessionId) {
	const root = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".cache", "chains-plugin");
	mkdirSync(join(root, "sessions"), { recursive: true });
	return join(root, "sessions", `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

/** Newest link write under .chains, so a save through any harness satisfies the checkpoint. */
function newestLinkTime(cwd) {
	const root = join(cwd, ".chains");
	if (!existsSync(root)) return 0;
	let newest = 0;
	for (const chain of readdirSync(root, { withFileTypes: true })) {
		if (!chain.isDirectory()) continue;
		for (const file of readdirSync(join(root, chain.name))) {
			if (file.endsWith(".md")) newest = Math.max(newest, statSync(join(root, chain.name, file)).mtimeMs);
		}
	}
	return newest;
}

/** Claude Code exports the project root to hooks; Codex hooks run in the session cwd. */
function projectDir(input) {
	return process.env.CLAUDE_PROJECT_DIR || input.cwd;
}

/**
 * One reminder per pressure cycle: the first stop at or past the line, unless a link was written since the last stop
 * below it. Rearms once use drops below the line.
 */
function checkpointDue(input) {
	const use = contextUse(input.transcript_path);
	if (!use) return undefined;
	const now = Date.now();
	const path = stateFile(input.session_id ?? "unknown");
	if (use.used < use.window * CHECKPOINT_RATIO) {
		writeFileSync(path, JSON.stringify({ belowAt: now }));
		return undefined;
	}
	const state = readJson(path) ?? {};
	if (state.reminded || newestLinkTime(projectDir(input)) > (state.belowAt ?? now)) return undefined;
	writeFileSync(path, JSON.stringify({ ...state, reminded: true }));
	return Math.round((use.used / use.window) * 100);
}

function pressureReason(percent) {
	return `Context is at ${percent}%. Save a Chain checkpoint (chain action save) before compaction drops detail: `
		+ "the current request, decisions, files changed or read, blockers, pending tasks, and a structured nextStep. "
		+ "If no Chain is active, choose a concise task-specific chain name. After saving, continue; compaction will hand the link back";
}

async function sessionStart(input) {
	const cwd = projectDir(input);
	if (!existsSync(join(cwd, ".chains"))) return undefined;
	const { ChainService } = await import("../lib/chains/service.ts");
	const { formatLoad } = await import("../lib/chains/format.ts");
	const service = new ChainService(cwd);
	const chains = await service.list();
	const latest = chains.map((chain) => chain.latest).filter(Boolean).sort((a, b) => (b.createdAt ?? b.filename).localeCompare(a.createdAt ?? a.filename))[0];
	if (!latest) return undefined;
	if (input.source === "compact") {
		const loaded = await service.load({ chain: latest.chain, branch: latest.branch, maxBytes: RESUME_BYTES });
		return `Context was compacted. Continue from the latest Chain checkpoint:\n\n${formatLoad(loaded)}`;
	}
	const next = latest.nextStep ? ` Next step: ${latest.nextStep.replace(/\.?$/, ".")}` : "";
	return `This project keeps Chains in .chains/ (${chains.length} chain(s)). Latest: ${latest.chain}@${latest.branch} "${latest.title}".${next} `
		+ "Resume prior work with the chain tool (action load or search); save progress with action save.";
}

async function run(input) {
	switch (input.hook_event_name) {
		case "SessionStart": {
			const context = await sessionStart(input);
			return context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : undefined;
		}
		case "Stop": {
			if (input.stop_hook_active) return undefined;
			const percent = checkpointDue(input);
			return percent === undefined ? undefined : { decision: "block", reason: pressureReason(percent) };
		}
		default:
			return undefined;
	}
}

try {
	const output = await run(JSON.parse(readFileSync(0, "utf8")));
	if (output) process.stdout.write(JSON.stringify(output));
} catch (error) {
	process.stderr.write(`chains hook: ${error instanceof Error ? error.message : String(error)}\n`);
}
