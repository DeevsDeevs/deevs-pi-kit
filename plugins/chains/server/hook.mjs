// Chains checkpoint discipline for Claude Code and Codex, the same rule Pi enforces:
// at 80% context every tool except the chain tools is refused until a Chain link is saved, stopping is refused once,
// and after compaction the latest link is handed back so work continues from it.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECKPOINT_RATIO = 0.8;
const TAIL_BYTES = 512 * 1024;
const RESUME_BYTES = 16 * 1024;
const ALLOWED_AT_PRESSURE = /chain_|^ToolSearch$|^AskUserQuestion$|^request_user_input$/;

/** Last known context use of the session: Codex rollouts report the window; Claude transcripts report usage only. */
export function contextUse(transcriptPath, claudeWindow = claudeContextWindow) {
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
			return { used, window: claudeWindow(used) };
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
export function newestLinkTime(cwd) {
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

/** Pressure state for one session: due since `dueAt` until a link is written after it; rearms once use drops below the line. */
export function checkpointDue(input, now = Date.now()) {
	const use = contextUse(input.transcript_path);
	if (!use) return undefined;
	const path = stateFile(input.session_id ?? "unknown");
	const state = readJson(path) ?? {};
	const percent = Math.round((use.used / use.window) * 100);
	if (use.used < use.window * CHECKPOINT_RATIO) {
		if (state.dueAt) writeFileSync(path, "{}");
		return undefined;
	}
	if (!state.dueAt) {
		state.dueAt = now;
		writeFileSync(path, JSON.stringify(state));
	}
	return newestLinkTime(input.cwd) >= state.dueAt ? undefined : percent;
}

function pressureReason(percent) {
	return `Context is at ${percent}%. Save the required Chain checkpoint with chain_save before using other tools: `
		+ "the current request, decisions, files changed or read, blockers, pending tasks, and a structured nextStep. "
		+ "If no Chain is active, choose a concise task-specific chain name. After saving, continue; compaction will hand the link back.";
}

async function sessionStart(input) {
	if (!existsSync(join(input.cwd, ".chains"))) return undefined;
	const { ChainService } = await import("../lib/chains/service.ts");
	const { formatLoad } = await import("../lib/chains/format.ts");
	const service = new ChainService(input.cwd);
	const chains = await service.list({});
	if (chains.length === 0) return undefined;
	const latest = chains.map((chain) => chain.latest).filter(Boolean).sort((a, b) => String(b.createdAt ?? b.filename).localeCompare(String(a.createdAt ?? a.filename)))[0];
	if (!latest) return undefined;
	if (input.source === "compact") {
		const loaded = await service.load({ chain: latest.chain, branch: latest.branch, maxBytes: RESUME_BYTES });
		return `Context was compacted. Continue from the latest Chain checkpoint:\n\n${formatLoad(loaded)}`;
	}
	const next = latest.nextStep ? ` Next step: ${latest.nextStep.replace(/\.?$/, ".")}` : "";
	return `This project keeps Chains in .chains/ (${chains.length} chain(s)). Latest: ${latest.chain}@${latest.branch} "${latest.title}".${next} `
		+ "Use chain_load or chain_search to resume prior work; save progress with chain_save.";
}

export async function run(input) {
	switch (input.hook_event_name) {
		case "SessionStart": {
			const context = await sessionStart(input);
			return context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : undefined;
		}
		case "PreToolUse": {
			if (ALLOWED_AT_PRESSURE.test(input.tool_name ?? "")) return undefined;
			const percent = checkpointDue(input);
			if (percent === undefined) return undefined;
			return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: pressureReason(percent) } };
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

if (realpathSync(process.argv[1] ?? ".") === fileURLToPath(import.meta.url)) {
	try {
		const output = await run(JSON.parse(readFileSync(0, "utf8")));
		if (output) process.stdout.write(JSON.stringify(output));
	} catch (error) {
		process.stderr.write(`chains hook: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
