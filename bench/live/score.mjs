import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countWakes, loadTranscript, transcriptModel, within } from "./transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIL_TOOLS = ["collaborator_inbox", "collaborator_reply"];
const FILE_TOOLS = ["read", "glob", "grep", "find", "ls", "safe_diff", "exec", "shell", "bash"];

/** Claude and Codex both prefix MCP tools with their generated server name; the mail tool is the last segment. */
function normalize(name) {
	return String(name).split("__").at(-1).toLowerCase();
}

function allowed(needs) {
	const set = new Set(MAIL_TOOLS);
	for (const need of needs ?? []) {
		if (need === "file") for (const tool of FILE_TOOLS) set.add(tool);
		else set.add(need);
	}
	return set;
}

function score(lane) {
	const path = join(HERE, "..", "results", "live", `${lane}.json`);
	const record = JSON.parse(readFileSync(path, "utf8"));
	const catalogue = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));
	const rowsByCollaborator = new Map();
	for (const collaborator of record.collaborators) {
		const rows = loadTranscript(collaborator.driver, collaborator.transcript);
		rowsByCollaborator.set(collaborator.id, rows);
		collaborator.transcriptModel = transcriptModel(rows) ?? "unknown";
		collaborator.transcriptEntries = rows.length;
	}
	for (const mail of record.mails) {
		const rows = rowsByCollaborator.get(mail.collaborator) ?? [];
		const end = mail.tReply === undefined ? (mail.settledAt ?? Date.now()) : mail.sentAt + mail.tReply;
		const slice = within(rows, mail.sentAt, end);
		const scenario = catalogue.scenarios.find(candidate => candidate.id === mail.scenario);
		const permitted = allowed(scenario?.needs);
		const tools = {};
		for (const row of slice) for (const tool of row.tools ?? []) tools[normalize(tool)] = (tools[normalize(tool)] ?? 0) + 1;
		mail.score = {
			toolCalls: Object.values(tools).reduce((total, count) => total + count, 0),
			stray: Object.entries(tools).filter(([tool]) => !permitted.has(tool)).reduce((total, [, count]) => total + count, 0),
			tools,
			context: Math.max(0, ...slice.map(row => row.input ?? 0)),
			input: slice.reduce((total, row) => total + (row.input ?? 0), 0),
			output: slice.reduce((total, row) => total + (row.output ?? 0), 0),
			wakes: countWakes(rows, mail.sentAt, end),
		};
	}
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`);
	return { path, record };
}

function table(record) {
	const header = ["mail", "collab", "model", "expect", "out", "t_work", "t_reply", "wakes", "tools", "stray", "ctx", "in_total", "out_tok"];
	const byId = new Map(record.scenarios.map(entry => [entry.id, entry]));
	const rows = record.mails.map((mail) => {
		const collaborator = record.collaborators.find(candidate => candidate.id === mail.collaborator);
		const scenario = byId.get(mail.scenario);
		return [
			mail.mailId,
			mail.collaborator,
			collaborator?.transcriptModel ?? "?",
			scenario?.expect ?? "-",
			scenario?.outcome ?? mail.outcome,
			mail.tWorking === undefined ? "-" : `${(mail.tWorking / 1000).toFixed(1)}s`,
			mail.tReply === undefined ? "-" : `${(mail.tReply / 1000).toFixed(1)}s`,
			String(mail.score.wakes),
			String(mail.score.toolCalls),
			String(mail.score.stray),
			String(mail.score.context ?? "-"),
			String(mail.score.input),
			String(mail.score.output),
		];
	});
	const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map(row => row[index].length)));
	const line = cells => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
	console.log(line(header));
	console.log(widths.map(width => "-".repeat(width)).join("  "));
	for (const row of rows) console.log(line(row));
}

const lanes = process.argv.slice(2).filter(argument => !argument.startsWith("--"));
for (const lane of lanes.length ? lanes : ["claude"]) {
	const { path, record } = score(lane);
	console.log(`\n== ${lane} (${path})`);
	for (const collaborator of record.collaborators) {
		console.log(`   ${collaborator.id}: ${collaborator.driver} requested ${collaborator.model}, transcript says ${collaborator.transcriptModel}, profile ${collaborator.profile}`);
	}
	table(record);
	if (record.findings?.length) for (const finding of record.findings) console.log(`   ! ${finding}`);
}
