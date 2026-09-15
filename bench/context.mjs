import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEncoding } from "js-tiktoken";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const results = join(repo, "bench", "results");
const budgetFile = join(repo, "bench", "context-budget.json");
const claudeCacheFile = join(repo, "bench", "claude-tokens.json");
const encoding = getEncoding("o200k_base");

const size = text => Buffer.byteLength(text ?? "", "utf8");
/** o200k_base is what the terra/astra/Codex side tokenizes with; Claude counts come from the CLI, see claudeTokens. */
const tokens = text => encoding.encode(text ?? "").length;
const read = path => readFileSync(join(repo, path), "utf8");
const hash = text => createHash("sha256").update(text).digest("hex").slice(0, 16);

function item(name, text) {
	return { item: name, text, bytes: size(text), tokens: tokens(text) };
}

function surface(name, items) {
	return { surface: name, items, total: items.reduce((sum, entry) => sum + entry.tokens, 0) };
}

async function registeredTools() {
	const extension = await import(pathToFileURL(join(repo, "extensions/runtime/index.ts")));
	const tools = [];
	const noop = () => {};
	extension.default({
		registerTool: tool => tools.push(tool),
		registerCommand: noop,
		registerEntryRenderer: noop,
		registerFlag: noop,
		on: noop,
		getAllTools: () => [],
		appendEntry: noop,
		sendMessage: noop,
	});
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description ?? "",
		promptSnippet: tool.promptSnippet ?? "",
		promptGuidelines: (tool.promptGuidelines ?? []).join("\n"),
		schema: JSON.stringify(tool.parameters ?? {}),
	}));
}

/** Rendered the way Pi's system prompt and tool list carry them: snippet and guideline lines, schema JSON. */
function toolSurface(tools) {
	const items = [];
	for (const tool of tools) {
		items.push(item(`${tool.name}.description`, tool.description));
		if (tool.promptSnippet) items.push(item(`${tool.name}.promptSnippet`, `- ${tool.name}: ${tool.promptSnippet}`));
		if (tool.promptGuidelines) items.push(item(`${tool.name}.promptGuidelines`, tool.promptGuidelines.split("\n").map(line => `- ${line}`).join("\n")));
		items.push(item(`${tool.name}.schema`, tool.schema));
	}
	return surface("piTools", items);
}

const INSTALLED_SKILLS = "/home/deevs/.pi/agent/git/github.com/DeevsDeevs/deevs-pi-kit/skills";

/** The exact `<skill>` block Pi's formatSkillsForPrompt emits, location included. */
function skillIndexEntry(skill) {
	const [name, description] = skill.index.split("\n");
	return `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${INSTALLED_SKILLS}/${skill.name}/SKILL.md</location>\n  </skill>`;
}

function skillFiles() {
	return readdirSync(join(repo, "skills"), { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => ({ name: entry.name, text: read(join("skills", entry.name, "SKILL.md")) }))
		.map(skill => {
			const match = /^---\n([\s\S]*?)\n---\n?/u.exec(skill.text);
			const frontmatter = match ? match[1] : "";
			return {
				name: skill.name,
				index: [/^name:\s*(.*)$/mu, /^description:\s*(.*)$/mu].map(pattern => pattern.exec(frontmatter)?.[1] ?? "").join("\n"),
				body: match ? skill.text.slice(match[0].length) : skill.text,
			};
		});
}

const sentences = text => text.split(/(?<=[.!?])\s+|\n+/u).map(line => line.trim()).filter(line => line.length > 0);
const shingles = sentence => {
	const words = sentence.toLowerCase().replaceAll(/[^a-z0-9\s]/gu, " ").split(/\s+/u).filter(Boolean);
	return words.slice(0, Math.max(0, words.length - 7)).map((_, index) => words.slice(index, index + 8).join(" "));
};

function readmeRuntimeSection(readme) {
	const match = /^### Hosted runtime$[\s\S]*?(?=^#{2,3} )/mu.exec(readme);
	return match ? match[0] : "";
}

function duplication(skillBody, sources) {
	const seen = new Map();
	for (const [source, text] of Object.entries(sources)) {
		for (const sentence of sentences(text)) {
			for (const shingle of shingles(sentence)) {
				if (!seen.has(shingle)) seen.set(shingle, new Set());
				seen.get(shingle).add(source);
			}
		}
	}
	const findings = [];
	for (const sentence of sentences(skillBody)) {
		const hits = new Map();
		for (const shingle of shingles(sentence)) {
			for (const source of seen.get(shingle) ?? []) {
				if (!hits.has(source)) hits.set(source, []);
				hits.get(source).push(shingle);
			}
		}
		if (hits.size > 0) findings.push({ sentence, tokens: tokens(sentence), matches: [...hits].map(([source, phrases]) => ({ source, shingles: phrases })) });
	}
	return findings;
}

export async function measure() {
	const tools = await registeredTools();
	const skills = skillFiles();
	const { toolDefinitions } = await import(pathToFileURL(join(repo, "extensions/runtime/mcp/tools.ts")));
	const { nativeMessagingConfiguration } = await import(pathToFileURL(join(repo, "extensions/runtime/mcp/native.ts")));
	const { NATIVE_STARTUP_MESSAGE } = await import(pathToFileURL(join(repo, "extensions/runtime/drivers.ts")));
	const native = nativeMessagingConfiguration({ root: "/tmp/x", targetKey: "agent_x", nodeExecutable: process.execPath });
	const readme = read("README.md");
	const protocol = read("extensions/runtime/PROTOCOL.md");
	const collaborators = skills.find(skill => skill.name === "collaborators");
	const surfaces = [
		toolSurface(tools),
		surface("skillIndex", skills.map(skill => item(skill.name, skillIndexEntry(skill)))),
		surface("skillBodies", skills.map(skill => item(skill.name, skill.body))),
		surface("nativeCatalog", toolDefinitions.map(tool => item(tool.name, JSON.stringify(tool)))),
		surface("nativeContext", [item("nativeMessagingConfiguration.context", native.context), item("NATIVE_STARTUP_MESSAGE", NATIVE_STARTUP_MESSAGE)]),
		surface("docs", [item("README.md", readme), item("extensions/runtime/PROTOCOL.md", protocol)]),
	];
	const toolProse = Object.fromEntries(tools.map(tool => [`tool:${tool.name}`, [tool.description, tool.promptGuidelines].join("\n")]));
	return {
		generatedAt: new Date().toISOString(),
		tokenizers: { tokens: "o200k_base (js-tiktoken)", claudeTokens: "claude -p prompt-size delta, cached in bench/claude-tokens.json" },
		surfaces,
		duplication: duplication(collaborators.body, {
			"README.md#hosted-runtime": readmeRuntimeSection(readme),
			"extensions/runtime/PROTOCOL.md": protocol,
			...toolProse,
		}),
	};
}

/** Claude has no public tokenizer: the CLI reports the prompt size, so one call per text against a baseline gives its exact count. */
function claudePromptTokens(appendedSystemPrompt) {
	const args = ["-p", "--model", "sonnet", "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--output-format", "json"];
	if (appendedSystemPrompt) args.push("--append-system-prompt", appendedSystemPrompt);
	const usage = JSON.parse(execFileSync("claude", [...args, "Reply with exactly: ok"], { encoding: "utf8", maxBuffer: 1 << 24 })).modelUsage["claude-sonnet-5"];
	return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

export function claudeTokens(report, { refresh = false } = {}) {
	const cache = existsSync(claudeCacheFile) ? JSON.parse(readFileSync(claudeCacheFile, "utf8")) : {};
	const items = report.surfaces.flatMap(entry => entry.items).filter(entry => entry.text);
	const missing = items.filter(entry => !(hash(entry.text) in cache));
	if (refresh && missing.length > 0) {
		const baseline = claudePromptTokens("");
		for (const entry of missing) cache[hash(entry.text)] = claudePromptTokens(entry.text) - baseline;
		writeFileSync(claudeCacheFile, `${JSON.stringify(cache, null, "\t")}\n`);
	}
	for (const entry of items) entry.claudeTokens = cache[hash(entry.text)];
	for (const entry of report.surfaces) {
		entry.claudeTotal = entry.items.every(each => each.claudeTokens !== undefined) ? entry.items.reduce((sum, each) => sum + each.claudeTokens, 0) : undefined;
	}
	return items.filter(entry => entry.claudeTokens === undefined).length;
}

export function budgetViolations(report, budget) {
	const totals = Object.fromEntries(report.surfaces.map(entry => [entry.surface, entry.total]));
	totals.collaboratorsSkillBody = report.surfaces
		.find(entry => entry.surface === "skillBodies").items
		.find(entry => entry.item === "collaborators").tokens;
	return Object.entries(budget)
		.filter(([key]) => key in totals)
		.filter(([key, ceiling]) => totals[key] > ceiling)
		.map(([key, ceiling]) => `${key}: ${totals[key]} tokens exceeds ceiling ${ceiling} tokens`);
}

export function readBudget() {
	return JSON.parse(readFileSync(budgetFile, "utf8"));
}

const cell = value => value === undefined ? "?" : String(value);

function table(report) {
	const rows = [];
	for (const entry of report.surfaces) {
		for (const each of entry.items) rows.push([entry.surface, each.item, cell(each.tokens), cell(each.claudeTokens), cell(each.bytes)]);
		rows.push([entry.surface, "**subtotal**", `**${entry.total}**`, `**${cell(entry.claudeTotal)}**`, `**${entry.items.reduce((sum, each) => sum + each.bytes, 0)}**`]);
	}
	const total = report.surfaces.reduce((sum, entry) => sum + entry.total, 0);
	const claude = report.surfaces.every(entry => entry.claudeTotal !== undefined) ? report.surfaces.reduce((sum, entry) => sum + entry.claudeTotal, 0) : undefined;
	rows.push(["all", "**total**", `**${total}**`, `**${cell(claude)}**`, ""]);
	return ["| surface | item | o200k tokens | claude tokens | bytes |", "| --- | --- | ---: | ---: | ---: |", ...rows.map(row => `| ${row.join(" | ")} |`)].join("\n");
}

function printDuplication(report) {
	const wasted = report.duplication.reduce((sum, finding) => sum + finding.tokens, 0);
	console.log(`\n## Duplication: ${report.duplication.length} collaborators-skill sentences (${wasted} o200k tokens) repeated elsewhere\n`);
	for (const finding of report.duplication) {
		console.log(`- (${finding.tokens} tokens) ${finding.sentence}`);
		for (const match of finding.matches) console.log(`  - also in ${match.source}: "${match.shingles[0]}"`);
	}
}

function stripText(report) {
	return { ...report, surfaces: report.surfaces.map(entry => ({ ...entry, items: entry.items.map(({ text, ...rest }) => rest) })) };
}

async function main() {
	const report = await measure();
	const uncounted = claudeTokens(report, { refresh: process.argv.includes("--claude") });
	console.log("# Static context cost\n");
	console.log(table(report));
	if (uncounted > 0) console.log(`\n${uncounted} items have no Claude count yet; run with --claude to measure them through the CLI (cached by content hash).`);
	printDuplication(report);
	mkdirSync(results, { recursive: true });
	writeFileSync(join(results, "context.json"), `${JSON.stringify(stripText(report), null, 2)}\n`);
	console.log(`\nWrote ${join(results, "context.json")}`);
	if (!process.argv.includes("--check")) return;
	const failures = budgetViolations(report, readBudget());
	if (failures.length === 0) {
		console.log("\nBudget OK.");
		return;
	}
	console.error(`\nContext budget exceeded (${budgetFile}):`);
	for (const failure of failures) console.error(`  ${failure}`);
	process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
