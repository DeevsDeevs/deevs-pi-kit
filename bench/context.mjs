import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const results = join(repo, "bench", "results");
const budgetFile = join(repo, "bench", "context-budget.json");

const size = text => Buffer.byteLength(text ?? "", "utf8");
const tokens = bytes => Math.ceil(bytes / 4);
const read = path => readFileSync(join(repo, path), "utf8");

function surface(name, items) {
	return { surface: name, items, total: items.reduce((sum, item) => sum + item.bytes, 0) };
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

function toolSurface(tools) {
	const items = [];
	for (const tool of tools) {
		for (const part of ["description", "promptSnippet", "promptGuidelines", "schema"]) {
			if (tool[part]) items.push({ item: `${tool.name}.${part}`, bytes: size(tool[part]) });
		}
	}
	return surface("piTools", items);
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

function nativeSurface(configuration, startupMessage) {
	return surface("nativeContext", [
		{ item: "nativeMessagingConfiguration.context", bytes: size(configuration) },
		{ item: "NATIVE_STARTUP_MESSAGE", bytes: size(startupMessage) },
	]);
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
		if (hits.size > 0) findings.push({ sentence, matches: [...hits].map(([source, phrases]) => ({ source, shingles: phrases })) });
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
		surface("skillIndex", skills.map(skill => ({ item: skill.name, bytes: size(skill.index) }))),
		surface("skillBodies", skills.map(skill => ({ item: skill.name, bytes: size(skill.body) }))),
		surface("nativeCatalog", toolDefinitions.map(tool => ({ item: tool.name, bytes: size(JSON.stringify(tool)) }))),
		nativeSurface(native.context, NATIVE_STARTUP_MESSAGE),
		surface("docs", [
			{ item: "README.md", bytes: size(readme) },
			{ item: "extensions/runtime/PROTOCOL.md", bytes: size(protocol) },
		]),
	];
	const toolProse = Object.fromEntries(tools.map(tool => [`tool:${tool.name}`, [tool.description, tool.promptGuidelines].join("\n")]));
	return {
		generatedAt: new Date().toISOString(),
		tokenApproximation: "tokens = ceil(bytes / 4)",
		surfaces,
		duplication: duplication(collaborators.body, {
			"README.md#hosted-runtime": readmeRuntimeSection(readme),
			"extensions/runtime/PROTOCOL.md": protocol,
			...toolProse,
		}),
	};
}

export function budgetViolations(report, budget) {
	const totals = Object.fromEntries(report.surfaces.map(entry => [entry.surface, entry.total]));
	totals.collaboratorsSkillBody = report.surfaces
		.find(entry => entry.surface === "skillBodies").items
		.find(item => item.item === "collaborators").bytes;
	return Object.entries(budget)
		.filter(([key]) => key in totals)
		.filter(([key, ceiling]) => totals[key] > ceiling)
		.map(([key, ceiling]) => `${key}: ${totals[key]} bytes exceeds ceiling ${ceiling} bytes`);
}

export function readBudget() {
	return JSON.parse(readFileSync(budgetFile, "utf8"));
}

function table(report) {
	const rows = [["surface", "item", "bytes", "tokens"]];
	for (const entry of report.surfaces) {
		for (const item of entry.items) rows.push([entry.surface, item.item, String(item.bytes), String(tokens(item.bytes))]);
		rows.push([entry.surface, "**subtotal**", `**${entry.total}**`, `**${tokens(entry.total)}**`]);
	}
	const total = report.surfaces.reduce((sum, entry) => sum + entry.total, 0);
	rows.push(["all", "**total**", `**${total}**`, `**${tokens(total)}**`]);
	const header = `| ${rows[0].join(" | ")} |\n| --- | --- | ---: | ---: |`;
	return [header, ...rows.slice(1).map(row => `| ${row.join(" | ")} |`)].join("\n");
}

function printDuplication(report) {
	console.log(`\n## Duplication: ${report.duplication.length} collaborators-skill sentences repeated elsewhere\n`);
	for (const finding of report.duplication) {
		console.log(`- ${finding.sentence}`);
		for (const match of finding.matches) console.log(`  - also in ${match.source}: "${match.shingles[0]}"`);
	}
}

async function main() {
	const report = await measure();
	console.log("# Static context cost (tokens approximated as ceil(bytes / 4))\n");
	console.log(table(report));
	printDuplication(report);
	mkdirSync(results, { recursive: true });
	writeFileSync(join(results, "context.json"), `${JSON.stringify(report, null, 2)}\n`);
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
