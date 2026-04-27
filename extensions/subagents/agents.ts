import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { AgentDefinition, AgentMode } from "./types.ts";

const MODULE_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);
const AGENTS_DIR = path.join(MODULE_DIR, "agents");

export function loadBuiltinAgents(): AgentDefinition[] {
	const files = readdirSync(AGENTS_DIR)
		.filter((file) => file.endsWith(".md"))
		.sort();
	return files.map((file) => parseAgentFile(path.join(AGENTS_DIR, file))).sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	const normalized = name.trim().toLowerCase();
	return agents.find((agent) => agent.name.toLowerCase() === normalized);
}

function parseAgentFile(filePath: string): AgentDefinition {
	const raw = readFileSync(filePath, "utf-8");
	const { frontmatter, body } = splitFrontmatter(raw);
	const name = stringValue(frontmatter.name) || path.basename(filePath, ".md");
	const description = stringValue(frontmatter.description) || firstNonEmptyLine(body) || name;
	const tools = listValue(frontmatter.tools, ["read", "bash"]);
	const mode = modeValue(frontmatter.mode);
	const write = booleanValue(frontmatter.write, false);
	const model = stringValue(frontmatter.model);
	const tags = listValue(frontmatter.tags, []);
	const disabled = booleanValue(frontmatter.disabled, false);

	return {
		name,
		description,
		tools,
		mode,
		write,
		model: model === "inherit" ? undefined : model,
		tags,
		disabled,
		body: body.trim(),
		filePath,
	};
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
	if (!raw.startsWith("---\n")) return { frontmatter: {}, body: raw };
	const end = raw.indexOf("\n---", 4);
	if (end < 0) return { frontmatter: {}, body: raw };
	const block = raw.slice(4, end).trim();
	const body = raw.slice(end + "\n---".length).replace(/^\s*\n/, "");
	const frontmatter: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const match = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		frontmatter[match[1]!] = unquote(match[2]!.trim());
	}
	return { frontmatter, body };
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
	return value;
}

function stringValue(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

function listValue(value: string | undefined, fallback: string[]): string[] {
	const text = value?.trim();
	if (!text) return [...fallback];
	return text.split(",").map((part) => part.trim()).filter(Boolean);
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function modeValue(value: string | undefined): AgentMode {
	return value?.trim() === "executor" ? "executor" : "advisory";
}

function firstNonEmptyLine(body: string): string | undefined {
	return body.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}
