// Context cost on the wire: splits each harness's captured first request (polygon/scenarios/context-wire.mjs)
// into components, counts them with o200k on the host and with real Claude calls (OpenRouter, in a container) per group.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const jsonl = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const textOf = (content) => typeof content === "string" ? content : (content ?? []).map((b) => b.text ?? "").join("\n");

/** Cuts `text` at each line that `starts` matches; the piece before the first cut is `head`. */
function cut(text, starts, head) {
	const pieces = [];
	let name = head, from = 0, offset = 0;
	for (const line of text.split("\n")) {
		const hit = starts(line);
		if (hit && offset > from) { pieces.push({ name, text: text.slice(from, offset) }); from = offset; }
		if (hit) name = hit;
		offset += line.length + 1;
	}
	pieces.push({ name, text: text.slice(from) });
	return pieces.filter((p) => p.text.trim());
}

/** Pi's system prompt: top-level XML sections, with <tools> lines, kit <rules> lines and <skill> entries itemised. */
function piSystem(system, vanillaRules) {
	const out = [];
	for (const piece of cut(system, (line) => /^<([a-z_]+)>$/.exec(line)?.[1].replace("available_skills", ""), "intro")) {
		if (piece.name === "tools") {
			for (const line of piece.text.split("\n").filter((l) => l.startsWith("- "))) out.push({ group: "tool-snippet", name: line.slice(2, line.indexOf(":")), text: `${line}\n` });
			out.push({ group: "base", name: "tools-frame", text: piece.text.split("\n").filter((l) => !l.startsWith("- ")).join("\n") });
		} else if (piece.name === "rules") {
			const kit = piece.text.split("\n").filter((l) => l.startsWith("- ") && !vanillaRules.has(l));
			out.push({ group: "base", name: "rules", text: piece.text.split("\n").filter((l) => !kit.includes(l)).join("\n") });
			kit.forEach((line, i) => out.push({ group: "tool-guideline", name: `rule ${String(i + 1).padStart(2, "0")}: ${line.slice(2, 70)}`, text: `${line}\n` }));
		} else if (piece.name === "skills") {
			const skills = [...piece.text.matchAll(/ {2}<skill>[\s\S]*?<\/skill>\n?/g)].map((m) => m[0]);
			for (const s of skills) out.push({ group: "skill-index", name: /<name>(.*)<\/name>/.exec(s)[1], text: s });
			out.push({ group: "skill-index", name: "(frame)", text: skills.reduce((t, s) => t.replace(s, ""), piece.text) });
		} else out.push({ group: ["intro", "docs", "cwd"].includes(piece.name) ? "base" : "kit-section", name: piece.name, text: piece.text });
	}
	return out;
}

const CLAUDE_STARTS = /^(# .+|Available agent types|The following skills|While auto mode|You are powered by|Today's date|When you launch multiple agents)/;

/** Components of one captured request, each with the wire fragment that carries it (for count_tokens leave-one-out). */
export function components(entry, { vanillaRules = new Set() } = {}) {
	const body = entry.body;
	if (entry.wire === "chat") {
		const system = body.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
		return [
			...piSystem(system, vanillaRules).map((c) => ({ ...c, kind: "system" })),
			...(body.tools ?? []).map((t) => ({ group: "tool-schema", name: t.function.name, kind: "tool", text: JSON.stringify(t.function), tool: t.function })),
		];
	}
	if (entry.wire === "anthropic" || entry.wire === "live") {
		const out = [];
		body.system.forEach((block, b) => {
			for (const piece of cut(block.text, (l) => CLAUDE_STARTS.exec(l)?.[1].slice(0, 40), `system[${b}]`)) out.push({ group: "system", name: piece.name, kind: "system", block: b, text: piece.text });
		});
		body.messages.forEach((m, i) => {
			if (m.role === "user" && i === 0) {
				for (const b of [m.content].flat()) {
					const t = textOf([b].flat());
					if (t.startsWith("POLYGON")) continue;
					out.push({ group: "context", name: /# (\w+)/.exec(t)?.[1] ?? t.slice(18, 60).trim(), kind: "message", message: i, text: t });
				}
			} else if (m.role === "system") {
				for (const piece of cut(textOf(m.content), (l) => CLAUDE_STARTS.exec(l)?.[1].slice(0, 40), "system-message")) out.push({ group: "context", name: piece.name, kind: "message", message: i, text: piece.text });
			}
		});
		for (const t of body.tools ?? []) out.push({ group: "tool-schema", name: t.name, kind: "tool", text: JSON.stringify(t), tool: t });
		return out;
	}
	// OpenAI Responses (Codex): instructions, developer messages, the additional_tools item, environment context.
	const out = [];
	if (body.instructions) out.push({ group: "system", name: "instructions", text: body.instructions });
	for (const t of body.tools ?? []) out.push({ group: "tool-schema", name: t.name ?? t.type, text: JSON.stringify(t) });
	for (const item of body.input ?? []) {
		if (item.type === "additional_tools") {
			const flat = (tools) => tools.flatMap((t) => t.type === "namespace" ? flat(t.tools) : [t]);
			for (const t of flat(item.tools)) out.push({ group: "tool-schema", name: t.name ?? t.type, text: JSON.stringify(t) });
			continue;
		}
		const t = textOf(item.content);
		if (t.startsWith("POLYGON")) continue;
		out.push({ group: item.role === "developer" ? "system" : "context", name: /^<(\w+)>/.exec(t.trim())?.[1] ?? t.slice(0, 40).replace(/\s+/g, " "), text: t });
	}
	return out;
}

/** The request an Anthropic model would get for this capture: Pi's chat wire mapped as Pi's anthropic provider maps it. */
export function anthropicRequest(entry, model) {
	const body = entry.body;
	if (entry.wire === "chat") {
		const system = body.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
		const prompt = body.messages.filter((m) => m.role === "user").map((m) => textOf(m.content)).join("\n");
		return { model, system: [{ type: "text", text: system }], tools: (body.tools ?? []).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })), messages: [{ role: "user", content: prompt }] };
	}
	return { model, system: body.system, tools: body.tools, messages: body.messages };
}

/** `request` without component `c`: a tool dropped, or its text removed from the system block or message that carries it. */
export function without(request, c, entry) {
	const strip = (blocks, text) => blocks.map((b) => b.type === "text" && b.text.includes(text) ? { ...b, text: b.text.replace(text, "") } : b);
	if (c.kind === "tool") return { ...request, tools: request.tools.filter((t) => t.name !== (c.tool.name)) };
	if (entry.wire === "chat" || c.kind === "system") return { ...request, system: strip(request.system, c.text) };
	return { ...request, messages: request.messages.map((m) => ({ ...m, content: typeof m.content === "string" ? m.content.replace(c.text, "") : strip(m.content, c.text) })) };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
const RESULTS = join(REPO, "bench", "results", "context-wire");

/** Captures by config label: the phase's main request (the one carrying tools), plus the Pi kit's woken turn. */
export function captures(dir, prefix) {
	if (!existsSync(join(dir, "bodies.jsonl"))) return {};
	const bodies = jsonl(join(dir, "bodies.jsonl"));
	const phases = JSON.parse(readFileSync(join(dir, "phases.json"), "utf8"));
	const out = {};
	for (const [label, range] of Object.entries(phases)) {
		if (!Array.isArray(range)) continue;
		const slice = bodies.slice(...range).filter((e) => label !== "pi-worker" || e.agent === "pi-worker");
		const main = slice.filter((e) => (e.body.tools ?? []).length || e.wire === "responses").sort((a, b) => JSON.stringify(b.body).length - JSON.stringify(a.body).length)[0] ?? slice[0];
		if (!main) continue;
		const name = ["pi-kit", "pi-worker"].includes(label) ? `${label}-${prefix}` : label;
		out[name] = label === "pi-kit" ? slice[0] : main;
		if (label === "pi-kit") slice.forEach((e, i) => { out[`${name}#${i}`] = e; });
	}
	return out;
}

/**
 * In a container holding the OpenRouter key at /key: Claude counts from real calls' reported input tokens (anthropic/claude-opus-5.5,
 * max_tokens 1, Anthropic-only routing). Per config: the full request, the bare prompt, and the request without each component group.
 */
async function countOpenRouter(out, only) {
	const key = readFileSync("/key", "utf8").trim();
	const model = "anthropic/claude-opus-5.5";
	const calls = [];
	const blocks = (content) => [content].flat().map((b) => typeof b === "string" ? { type: "text", text: b } : (({ cache_control, ...rest }) => rest)(b)).filter((b) => b.type !== "text" || b.text.trim());
	const count = async (request) => {
		// Anthropic takes no system role inside messages; Claude Code's environment message rides as user text instead.
		const messages = [];
		for (const m of request.messages) {
			const role = m.role === "system" ? "user" : m.role;
			if (messages.at(-1)?.role === role) messages.at(-1).content.push(...blocks(m.content));
			else messages.push({ role, content: blocks(m.content) });
		}
		const system = request.system ? blocks(request.system) : [];
		const body = { model, max_tokens: 1, messages, ...(system.length ? { system } : {}),
			...(request.tools?.length ? { tools: request.tools.map(({ cache_control, ...t }) => t) } : {}), provider: { only: ["anthropic"] } };
		const res = await fetch("https://openrouter.ai/api/v1/messages", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "anthropic-version": "2023-06-01" } });
		const json = await res.json();
		if (!res.ok) throw new Error(`openrouter ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
		const u = json.usage;
		const n = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
		calls.push(n);
		// ponytail: hard stop near the lane's $5 OpenRouter cap at $4/M input.
		if (calls.reduce((a, b) => a + b, 0) > 1_100_000) throw new Error("input-token budget reached");
		return n;
	};
	const sources = { ...captures("/kit/bench/results/context-wire/new", "new"), ...captures("/kit/bench/results/context-wire/old", "old") };
	const live = captures("/kit/bench/results/context-wire/live", "live")["claude-print"];
	if (live) sources["claude-print-live"] = live;
	const vanillaRules = new Set(textOf(sources["pi-vanilla"].body.messages[0].content).split("\n").filter((l) => l.startsWith("- ")));
	// `only` recounts some configs and keeps the rest of an earlier result.
	const result = only && existsSync(out) ? { ...JSON.parse(readFileSync(out, "utf8")), errors: {} } : { model, configs: {}, errors: {} };
	const before = result.calls ?? 0, spentBefore = result.inputTokens ?? 0;
	for (const label of only ?? ["claude-print-live", "pi-vanilla", "pi-kit-new", "pi-kit-old", "pi-worker-new", "pi-worker-old", "claude-print", "claude-interactive"]) {
		const entry = sources[label];
		if (!entry) continue;
		try {
			const request = anthropicRequest(entry, model);
			const prompt = request.messages.flatMap((m) => [m.content].flat()).map((b) => typeof b === "string" ? b : b.text ?? "").find((t) => t.startsWith("POLYGON")) ?? "x";
			const parts = components(entry, { vanillaRules });
			const total = await count(request);
			const promptOnly = await count({ messages: [{ role: "user", content: prompt }] });
			const groups = {};
			for (const group of [...new Set(parts.map((c) => c.group))]) {
				groups[group] = total - await count(parts.filter((c) => c.group === group).reduce((r, c) => without(r, c, entry), request));
			}
			result.configs[label] = { total, promptOnly, overhead: total - promptOnly, groups };
			console.log(label, JSON.stringify(result.configs[label]));
		} catch (error) { result.errors[label] = String(error).slice(0, 400); console.log(label, result.errors[label]); }
	}
	result.calls = before + calls.length;
	result.inputTokens = spentBefore + calls.reduce((a, b) => a + b, 0);
	writeFileSync(out, JSON.stringify(result, null, 2));
}

/** Host: o200k per config and component, Claude counts merged in, the woken-turn cache check, and the chart-ready summary. */
async function main() {
	const { getEncoding } = await import("js-tiktoken");
	const enc = getEncoding("o200k_base");
	const tokens = (s) => enc.encode(s ?? "", "all").length;
	const caps = { ...captures(join(RESULTS, "new"), "new"), ...captures(join(RESULTS, "old"), "old") };
	const live = captures(join(RESULTS, "live"), "live")["claude-print"];
	if (live) caps["claude-print-live"] = live;
	const claude = existsSync(join(RESULTS, "claude-counts.json")) ? JSON.parse(readFileSync(join(RESULTS, "claude-counts.json"), "utf8")) : { configs: {} };
	const vanillaRules = new Set(textOf(caps["pi-vanilla"].body.messages[0].content).split("\n").filter((l) => l.startsWith("- ")));
	const configs = {};
	for (const [label, entry] of Object.entries(caps)) {
		if (label.includes("#")) continue;
		const parts = components(entry, { vanillaRules });
		const measured = claude.configs[label];
		const rows = parts.map((c) => ({ group: c.group, name: c.name, o200k: tokens(c.text), bytes: Buffer.byteLength(c.text) }));
		const byGroup = {};
		for (const r of rows) {
			byGroup[r.group] ??= { o200k: 0, count: 0 };
			byGroup[r.group].o200k += r.o200k; byGroup[r.group].count++;
		}
		// Claude per group is measured (leave-the-group-out); per component it is the group's Claude/o200k ratio applied to its o200k.
		for (const [group, g] of Object.entries(byGroup)) g.claude = measured?.groups[group] ?? null;
		for (const r of rows) r.claudeEst = byGroup[r.group].claude === null ? null : Math.round(r.o200k * byGroup[r.group].claude / Math.max(1, byGroup[r.group].o200k));
		configs[label] = {
			wire: entry.wire, model: entry.body.model, tools: (entry.body.tools ?? []).length,
			o200k: rows.reduce((sum, r) => sum + r.o200k, 0), bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
			claude: measured?.overhead ?? null, byGroup, components: rows.sort((x, y) => y.o200k - x.o200k),
		};
	}
	if (configs["claude-print-live"]) configs["claude-print-live"].reportedByClaudeCode = (() => {
		const usage = JSON.parse(readFileSync(join(RESULTS, "live", "claude-print.json"), "utf8")).usage;
		return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
	})();
	// The woken turn: does the prefix the provider caches (system prompt, tools, earlier messages) survive a task-notification wake?
	const lead = Object.entries(caps).filter(([l]) => l.startsWith("pi-kit-new#")).map(([, e]) => e.body);
	const sys = (b) => b.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
	const woken = lead.at(-1);
	const triggered = lead.length >= 3 ? {
		userTurnRequest: 0, wokenTurnRequest: lead.length - 1,
		systemPromptIdentical: sys(lead[0]) === sys(woken),
		toolsIdentical: JSON.stringify(lead[0].tools) === JSON.stringify(woken.tools),
		messagesPrefixStable: JSON.stringify(woken.messages.slice(0, lead.at(-2).messages.length)) === JSON.stringify(lead.at(-2).messages),
		wokenTurnLastMessage: woken.messages.at(-1).role,
		notificationTokens: tokens(textOf(woken.messages.at(-1).content)),
	} : null;
	const kitNew = configs["pi-kit-new"], kitOld = configs["pi-kit-old"], vanilla = configs["pi-vanilla"];
	const vanillaNames = new Set(vanilla.components.map((c) => `${c.group}/${c.name}`));
	const kitAdds = (cfg) => cfg.components.filter((c) => !vanillaNames.has(`${c.group}/${c.name}`) || c.group === "tool-schema" && !["read", "bash", "edit", "write"].includes(c.name));
	const summary = {
		generatedAt: new Date().toISOString(),
		tokenizers: { o200k: "o200k_base via js-tiktoken over each component's wire text (tool = its JSON schema object)", claude: `real ${claude.model ?? "n/a"} calls on OpenRouter (Anthropic-routed, max_tokens 1), usage input tokens: config = full request minus the bare prompt; group = full minus the request without that group; component claudeEst = o200k scaled by its group's measured ratio` },
		versions: { pi: "1.0.4 (Bun release binary)", claudeCode: "2.1.292", codex: "0.160.1", kitOld: "96370a3", kitNew: process.env.KIT_NEW_SHA ?? "feature/cc-parity HEAD" },
		notes: ["Collaborators v2 is still being merged; pi-kit-new is the feature/cc-parity HEAD before it lands.", "Fixture repo has no AGENTS.md/CLAUDE.md; context files are 0 for every config and add their own size on top.", "Claude Code runs on its default model (claude-opus-5-5) against the puppet with an API key (-p reports the Agent SDK identity line); *-live rows were captured on the subscription login."],
		totals: Object.fromEntries(Object.entries(configs).map(([l, c]) => [l, { o200k: c.o200k ?? null, claude: c.claude ?? null, tools: c.tools ?? null }])),
		kitDelta: { old: { o200k: kitOld.o200k - vanilla.o200k, claude: kitOld.claude !== null && vanilla.claude !== null ? kitOld.claude - vanilla.claude : null }, new: { o200k: kitNew.o200k - vanilla.o200k, claude: kitNew.claude !== null && vanilla.claude !== null ? kitNew.claude - vanilla.claude : null } },
		kitTopContributors: kitAdds(kitNew).slice(0, 25).map(({ group, name, o200k, claudeEst }) => ({ group, name, o200k, claudeEst })),
		openrouter: { model: claude.model, calls: claude.calls, inputTokens: claude.inputTokens },
		triggeredTurn: triggered,
		configs,
	};
	mkdirSync(RESULTS, { recursive: true });
	writeFileSync(join(RESULTS, "summary.json"), JSON.stringify(summary, null, 2));
	const out = process.argv[2];
	if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(summary, null, 2)); }
	console.log("config".padEnd(28), "tools", "o200k".padStart(7), "claude".padStart(7));
	for (const [l, c] of Object.entries(summary.totals)) console.log(l.padEnd(28), String(c.tools ?? "").padStart(5), String(c.o200k ?? "").padStart(7), String(c.claude ?? "").padStart(7));
	console.log("triggered turn:", JSON.stringify(triggered));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await (process.argv[2] === "--openrouter" ? countOpenRouter(process.argv[3], process.argv[4]?.split(",")) : main());
