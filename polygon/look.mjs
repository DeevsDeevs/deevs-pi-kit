// Structural readers. Nothing here reads model prose.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const jsonl = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** Custom messages that reached the lead's context (runtime deliveries and other extension notifications). */
export const notifications = (events) => events.filter((e) => e.type === "message_end" && e.message?.role === "custom")
	.map((e) => ({ customType: e.message.customType, details: e.message.details }));

const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n");
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/** `text` is the kit's own result text, read for ids and listings only. */
export const toolCalls = (events) => events.filter((e) => e.type === "tool_execution_end")
	.map((e) => ({ name: e.toolName, isError: e.isError, details: e.result?.details, text: textOf(e.result?.content) }));

/** Agent ids (A.8) in a kit text. */
export const agentIds = (text) => text.match(/\ba[0-9a-f]{16}\b/g) ?? [];

const note = (m) => ({ taskId: tag(textOf(m.content), "task-id"), status: tag(textOf(m.content), "status"), notificationId: m.details?.notificationId });

/** `<task-notification>` messages (A.5) that reached the lead, read by markup. */
export const taskNotes = (events) => events.filter((e) => e.type === "message_end" && e.message?.customType === "task-notification").map((e) => note(e.message));

/** The same notifications as the session files hold them; the session is the ack. */
export const sessionNotes = (t) => entries(t).filter((e) => e.type === "custom_message" && e.customType === "task-notification").map(note);

export const dialogs = (events) => events.filter((e) => e.type === "extension_ui_request" && DIALOGS.has(e.method)).length;

export const runs = (events) => events.filter((e) => e.type === "agent_start").length;

export function entries(t) {
	const root = join(t.agentDir, "sessions");
	let files = [];
	try { files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
	return files.flatMap((f) => jsonl(join(root, f)));
}

export const requests = (t) => jsonl(t.requestLog);

/** Every live process carrying this scenario's POLYGON_RUN tag. */
export function procs(t) {
	const found = [];
	for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
		try {
			if (!readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`POLYGON_RUN=${t.tag}`)) continue;
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") continue;
			found.push({ pid: Number(pid), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) });
		} catch {}
	}
	return found;
}
