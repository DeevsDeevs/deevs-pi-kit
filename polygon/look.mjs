// Structural readers. Nothing here reads model prose.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
export const jsonl = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** Custom messages that reached the lead's context (runtime deliveries and other extension notifications). */
export const notifications = (events) => events.filter((e) => e.type === "message_end" && e.message?.role === "custom")
	.map((e) => ({ customType: e.message.customType, details: e.message.details }));

const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n");

/** `text` is the kit's own result text, read for ids and listings only. */
export const toolCalls = (events) => events.filter((e) => e.type === "tool_execution_end")
	.map((e) => ({ id: e.toolCallId, name: e.toolName, isError: e.isError, details: e.result?.details, text: textOf(e.result?.content) }));

/** Agent ids (A.8) in a kit text. */
export const agentIds = (text) => text.match(/\ba[0-9a-f]{16}\b/g) ?? [];

/** A `<task-notification>` (A.5), its tags read as protocol framing. */
const note = (m) => {
	const tag = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(textOf(m.content))?.[1];
	return { notificationId: m.details?.notificationId, taskId: tag("task-id"), status: tag("status"), result: tag("result"), toolUseId: tag("tool-use-id"), limited: tag("limited"), usage: tag("usage"), failures: tag("failures"), diagnostics: tag("diagnostics"), recovery: tag("recovery"), outputFile: tag("output-file"), event: tag("event"), caughtUp: tag("caught_up") };
};

/** The task notifications that reached the lead. */
export const taskNotifications = (events) => events.filter((e) => e.type === "message_end" && e.message?.customType === "task-notification").map((e) => note(e.message));

/** The same notifications as the session files hold them; the session is the ack. */
export const sessionNotes = (t) => entries(t).filter((e) => e.type === "custom_message" && e.customType === "task-notification").map(note);

export const dialogs = (events) => events.filter((e) => e.type === "extension_ui_request" && DIALOGS.has(e.method)).length;

export const runs = (events) => events.filter((e) => e.type === "agent_start").length;

export const settled = (events) => events.filter((e) => e.type === "agent_settled").length;

export function entries(t) {
	const root = join(t.agentDir, "sessions");
	let files = [];
	try { files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
	return files.flatMap((f) => jsonl(join(root, f)));
}

export const requests = (t) => jsonl(t.requestLog);

/** Every `.missions/<slug>/state.json` in the fixture repo. */
export function missionStates(t) {
	const root = join(t.repo, ".missions");
	if (!existsSync(root)) return [];
	return readdirSync(root).filter((slug) => existsSync(join(root, slug, "state.json"))).map((slug) => JSON.parse(readFileSync(join(root, slug, "state.json"), "utf8")));
}

/** Every live process carrying this scenario's POLYGON_RUN tag and, given `marker`, an env entry that starts with it. */
export function procs(t, marker) {
	const found = [];
	for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
		try {
			const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			if (!env.includes(`POLYGON_RUN=${t.tag}`) || (marker && !env.some((v) => v.startsWith(marker)))) continue;
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") continue;
			found.push({ pid: Number(pid), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) });
		} catch {}
	}
	return found;
}

/** This scenario's live processes that carry PI_KIT_OWNER: kit agents' tool children, jobs and monitor scripts. */
export const owned = (t) => procs(t, "PI_KIT_OWNER=");
