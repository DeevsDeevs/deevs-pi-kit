import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A persona, `agents/<name>.md`: frontmatter `name, description, tools, model, effort, isolation`, then its prompt. */
export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	effort?: string;
	isolation?: "worktree";
	body: string;
}

const AGENTS_DIR = fileURLToPath(new URL("agents", import.meta.url));

export function loadBuiltinAgents(): AgentDefinition[] {
	return readdirSync(AGENTS_DIR).filter((file) => file.endsWith(".md")).map((file) => parseAgentFile(join(AGENTS_DIR, file))).sort((a, b) => a.name.localeCompare(b.name));
}

function parseAgentFile(file: string): AgentDefinition {
	const raw = readFileSync(file, "utf8");
	const end = raw.startsWith("---\n") ? raw.indexOf("\n---", 4) : -1;
	const fields = new Map((end < 0 ? [] : raw.slice(4, end).split(/\r?\n/)).flatMap((line) => {
		const match = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
		return match ? [[match[1]!, match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")] as const] : [];
	}));
	const name = fields.get("name") || basename(file, ".md");
	return {
		name,
		description: fields.get("description") || name,
		tools: (fields.get("tools") || "read, grep, find, ls, bash").split(",").map((tool) => tool.trim()).filter(Boolean),
		model: fields.get("model") || undefined,
		effort: fields.get("effort") || undefined,
		isolation: fields.get("isolation") === "worktree" ? "worktree" : undefined,
		body: (end < 0 ? raw : raw.slice(end + 4)).trim(),
	};
}
