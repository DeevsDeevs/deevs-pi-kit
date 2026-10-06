// Structural readers. Nothing here reads model prose.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
const jsonl = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

/** Custom messages that reached the lead's context (runtime deliveries and other extension notifications). */
export const notifications = (events) => events.filter((e) => e.type === "message_end" && e.message?.role === "custom")
	.map((e) => ({ customType: e.message.customType, details: e.message.details }));

/** `<task-notification>` messages that reached the lead, with their tags read as protocol framing. */
export const taskNotifications = (events) => events.filter((e) => e.type === "message_end" && e.message?.role === "custom" && e.message.customType === "task-notification")
	.map((e) => {
		const content = typeof e.message.content === "string" ? e.message.content : e.message.content.map((b) => b.text ?? "").join("");
		const tag = (name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(content)?.[1];
		return { id: e.message.details?.notificationId, taskId: tag("task-id"), status: tag("status"), result: tag("result"), toolUseId: tag("tool-use-id"), limited: tag("limited"), usage: tag("usage") };
	});

export const toolCalls = (events) => events.filter((e) => e.type === "tool_execution_end")
	.map((e) => ({ name: e.toolName, isError: e.isError, details: e.result?.details }));

export const dialogs = (events) => events.filter((e) => e.type === "extension_ui_request" && DIALOGS.has(e.method)).length;

export const runs = (events) => events.filter((e) => e.type === "agent_start").length;

export function entries(t) {
	const root = join(t.agentDir, "sessions");
	let files = [];
	try { files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
	return files.flatMap((f) => jsonl(join(root, f)));
}

export const requests = (t) => jsonl(t.requestLog);

/** Waits for a condition outside the lead's event stream: files, the request log, session entries. */
export async function poll(check, ms, label) {
	for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error(`timeout ${ms}ms waiting for ${label}`);
}

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
