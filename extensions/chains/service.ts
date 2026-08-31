import type { Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractTitle, parseCreatedAt, parseMetadata, slugify, stripFrontmatter, truncateText, withMetadata } from "./parser.ts";
import { unicodeTerms } from "../shared/terms.ts";
import type {
	ChainBranchInfo,
	ChainContextInput,
	ChainContextResult,
	ChainForkInput,
	ChainForkResult,
	ChainLinkInfo,
	ChainListInput,
	ChainListItem,
	ChainLoadInput,
	ChainLoadResult,
	ChainSaveInput,
	ChainSaveResult,
	ChainSearchInput,
	ChainSearchMatch,
	ChainSearchResult,
} from "./types.ts";

const DEFAULT_BRANCH = "main";
const DEFAULT_MAX_BYTES = 65_536;
const MAX_BYTES = 262_144;
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 100;
const MAX_QUERY_CHARS = 1000;
const MAX_LOOKUP_TERMS = 32;
const MAX_FULL_LINK_BYTES = 1_000_000;
const DEFAULT_LOOKUP_HALF_LIFE_DAYS = 30;
const DEFAULT_LOOKUP_RECENCY_WEIGHT = 0.15;
const DEFAULT_CONTEXT_PARENT_LINKS = 2;
const DEFAULT_CONTEXT_RECENT_LINKS = 3;
const DEFAULT_CONTEXT_SEARCH_MATCHES = 8;

export class ChainService {
	private cwd: string;

	constructor(cwd: string) { this.cwd = cwd; }

	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	root(): string {
		return join(this.cwd, ".chains");
	}

	async save(input: ChainSaveInput): Promise<ChainSaveResult> {
		const chain = validateChainName(input.chain);
		const branch = validateBranchName(input.branch ?? DEFAULT_BRANCH);
		const rawContent = normalizeContent(input.content);
		const title = input.title?.trim() || extractTitle(rawContent, "chain-link.md");
		const slug = slugify(input.slug || title);
		const latest = await this.latest(chain, branch);
		if (!input.parent && branch !== DEFAULT_BRANCH && !latest) throw new Error("First link on a non-main branch requires a parent link. Use /chain-fork or pass parent.");
		const parent = input.parent ? validateLinkName(input.parent) : latest?.filename;
		const dir = await this.ensureChainDir(chain, true);

		const content = withMetadata(rawContent, { chain, branch, parent, nextStep: input.nextStep?.trim().slice(0, 1_000), created: new Date().toISOString() });
		for (let attempt = 0; attempt < 10; attempt++) {
			const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
			const filename = `${timestamp()}-${slug}${suffix}.md`;
			const path = join(dir, filename);
			try {
				const handle = await open(path, "wx");
				try {
					await handle.writeFile(content, "utf8");
				} finally {
					await handle.close();
				}
				return { link: await this.linkInfo(chain, filename) };
			} catch (error) {
				if (isAlreadyExists(error)) continue;
				throw error;
			}
		}
		throw new Error("Could not allocate unique chain link filename after 10 attempts.");
	}

	async load(input: ChainLoadInput): Promise<ChainLoadResult> {
		const chain = validateChainName(input.chain);
		const branch = input.branch ? validateBranchName(input.branch) : input.link ? undefined : DEFAULT_BRANCH;
		const links = await this.links(chain, branch);
		if (links.length === 0) throw new Error(`No chain links found for ${chain}${branch ? ` branch ${branch}` : ""}. Use /chain-list to see chains.`);
		const filename = input.link ? validateLinkName(input.link) : links[0]!.filename;
		const link = links.find((item) => item.filename === filename) ?? (input.link ? await this.findLink(chain, filename) : null);
		if (!link || (branch && link.branch !== branch)) throw new Error(`Chain link not found: ${chain}/${filename}${branch ? ` on branch ${branch}` : ""}`);
		const maxBytes = clamp(input.maxBytes ?? DEFAULT_MAX_BYTES, 1, MAX_BYTES);
		const raw = await this.readLinkContent(link.chain, link.filename, maxBytes + 1);
		const { text, truncated } = truncateText(raw, maxBytes);
		return { link, content: text, truncated, recent: links.slice(0, 5) };
	}

	async fork(input: ChainForkInput): Promise<ChainForkResult> {
		const chain = validateChainName(input.chain);
		const branch = validateBranchName(input.branch);
		if (branch === DEFAULT_BRANCH) throw new Error("Refusing to fork into main. Choose a new branch name.");
		const fromBranch = input.fromBranch ? validateBranchName(input.fromBranch) : undefined;
		const parent = input.from ? await this.findLink(chain, validateLinkName(input.from)) : await this.latest(chain, fromBranch);
		if (!parent) throw new Error(`No parent link found for ${chain}${fromBranch ? ` branch ${fromBranch}` : ""}.`);
		const existing = await this.links(chain, branch);
		if (existing.length > 0) throw new Error(`Branch already has links: ${chain}/${branch}`);
		return {
			chain,
			branch,
			parent,
			prompt: `Create the first link on branch "${branch}" from parent "${parent.filename}". Call chain_save with chain="${chain}", branch="${branch}", parent="${parent.filename}".`,
		};
	}

	async list(input: ChainListInput = {}): Promise<ChainListItem[]> {
		const root = await this.ensureRootDir(false);
		if (!root) return [];
		let entries: Dirent<string>[];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const chains = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
		const result: ChainListItem[] = [];
		for (const chain of chains) {
			if (!isValidSimpleName(chain)) continue;
			const links = await this.links(chain);
			result.push({
				chain,
				count: links.length,
				latest: links[0] ?? null,
				branches: input.includeBranches ? branchInfos(chain, links) : undefined,
				links: input.includeLinks ? links : undefined,
			});
		}
		return result;
	}

	async search(input: ChainSearchInput): Promise<ChainSearchResult> {
		const query = validateQuery(input.query);
		const branch = input.branch ? validateBranchName(input.branch) : undefined;
		const maxResults = clamp(input.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
		const contextLines = clamp(input.contextLines ?? 1, 0, 5);
		const chains = input.chain ? [{ chain: validateChainName(input.chain), count: 0, latest: null }] : await this.list();
		const regex = input.mode === "regex";
		const matcher = createMatcher(query, regex, Boolean(input.caseSensitive));
		const matches: ChainSearchMatch[] = [];

		for (const item of chains) {
			const links = await this.links(item.chain, branch);
			for (const link of links) {
				const content = await this.readFullLinkContent(link.chain, link.filename);
				const lines = content.split(/\r?\n/);
				for (let index = 0; index < lines.length; index++) {
					if (!matcher(lines[index]!)) continue;
					matches.push({ link, line: index + 1, snippet: snippet(lines, index, contextLines) });
					if (matches.length >= maxResults) return { query, matches, truncated: true, regex };
				}
			}
		}
		return { query, matches, truncated: false, regex };
	}

	async rankedSearch(input: RankedSearchInput): Promise<RankedSearchResult> {
		const query = validateQuery(input.query);
		const branch = input.branch ? validateBranchName(input.branch) : undefined;
		const maxResults = clamp(input.maxResults ?? DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
		const halfLifeDays = clamp(input.recencyHalfLifeDays ?? DEFAULT_LOOKUP_HALF_LIFE_DAYS, 1, 3650);
		const recencyWeight = clampFloat(input.recencyWeight ?? DEFAULT_LOOKUP_RECENCY_WEIGHT, 0, 1);
		const chains = input.chain ? [{ chain: validateChainName(input.chain), count: 0, latest: null }] : await this.list();
		const queryTerms = tokenize(query).slice(0, MAX_LOOKUP_TERMS);
		if (queryTerms.length === 0) throw new Error("Lookup query has no searchable terms.");
		const queryTermSet = new Set(queryTerms);
		const docs: LookupDocument[] = [];

		for (const item of chains) {
			const links = await this.links(item.chain, branch);
			for (const link of links) docs.push(await this.lookupDocument(link));
		}
		if (docs.length === 0) return { query, matches: [], truncated: false };

		const documentFrequency = new Map<string, number>();
		for (const doc of docs) {
			for (const term of queryTermSet) if (doc.termFrequency.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
		const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
		const matches: RankedSearchMatch[] = [];
		for (const doc of docs) {
			const matchedTerms = [...queryTermSet].filter((term) => doc.termFrequency.has(term));
			if (matchedTerms.length === 0) continue;
			const lexicalScore = bm25Score(doc, matchedTerms, documentFrequency, docs.length, averageLength) + phraseBoost(doc, query);
			const recencyScore = Math.exp(-Math.max(0, doc.link.ageDays ?? 0) / halfLifeDays);
			const score = lexicalScore * (1 - recencyWeight) + recencyScore * recencyWeight;
			matches.push({ link: doc.link, score, lexicalScore, recencyScore, matchedTerms, snippet: bestLookupSnippet(doc, matchedTerms) });
		}
		matches.sort((left, right) => right.score - left.score || (right.link.createdAt ?? "").localeCompare(left.link.createdAt ?? ""));
		return { query, matches: matches.slice(0, maxResults), truncated: matches.length > maxResults };
	}

	async context(input: ChainContextInput): Promise<ChainContextResult> {
		const maxBytes = clamp(input.maxBytes ?? DEFAULT_MAX_BYTES, 1, MAX_BYTES);
		const loaded = await this.load({ chain: input.chain, branch: input.branch, link: input.link, maxBytes });
		const mode = input.mode ?? "pack";
		const compact = input.compact ?? mode === "pack";
		if (mode === "latest") {
			const context = formatContextPack({ link: loaded.link, content: loaded.content, truncated: loaded.truncated });
			return { link: loaded.link, context, truncated: loaded.truncated, includedLinks: [loaded.link], searchMatches: [] };
		}

		const parts: string[] = [];
		const includedLinks: ChainLinkInfo[] = [loaded.link];
		let truncated = loaded.truncated;
		let remaining = maxBytes;
		const append = (text: string) => {
			if (remaining <= 0) {
				truncated = true;
				return;
			}
			const clipped = truncateText(text, remaining);
			parts.push(clipped.text);
			remaining -= Buffer.byteLength(clipped.text, "utf8");
			if (clipped.truncated) truncated = true;
		};

		append(`# Chain Context Pack: ${loaded.link.chain}@${loaded.link.branch}/${loaded.link.filename}\n\n`);
		append(formatLinkBlock("Current link", loaded.link, compact ? compactMarkdown(loaded.content) : loaded.content));

		let parentName = loaded.link.parent;
		const includeParents = clamp(input.includeParents ?? DEFAULT_CONTEXT_PARENT_LINKS, 0, 10);
		for (let i = 0; i < includeParents && parentName; i++) {
			const parent = await this.findLink(loaded.link.chain, parentName);
			if (!parent) break;
			const content = await this.readFullLinkContent(parent.chain, parent.filename);
			includedLinks.push(parent);
			append(formatLinkBlock(`Parent ${i + 1}`, parent, compact ? compactMarkdown(content) : content));
			parentName = parent.parent;
		}

		const recentLinks = clamp(input.recentLinks ?? DEFAULT_CONTEXT_RECENT_LINKS, 0, 20);
		if (recentLinks > 0) {
			const recent = (await this.links(loaded.link.chain, loaded.link.branch)).filter((link) => !includedLinks.some((item) => item.filename === link.filename)).slice(0, recentLinks);
			if (recent.length > 0) append(`\n## Recent links\n${recent.map((link) => `- ${link.filename}: ${link.title}${link.nextStep ? ` — next: ${link.nextStep}` : ""}`).join("\n")}\n`);
		}

		let searchMatches: ChainSearchMatch[] = [];
		if (input.searchQuery?.trim()) {
			const searchMode = input.searchMode ?? "lookup";
			if (searchMode === "lookup") {
				const lookup = await this.rankedSearch({ chain: loaded.link.chain, branch: loaded.link.branch, query: input.searchQuery, maxResults: input.maxSearchMatches ?? DEFAULT_CONTEXT_SEARCH_MATCHES });
				searchMatches = lookup.matches.map((match) => ({ link: match.link, line: Number(match.snippet.split(":", 1)[0]) || 1, snippet: match.snippet }));
				if (lookup.matches.length > 0) append(`\n## Relevant hits for ${JSON.stringify(input.searchQuery)}\n${lookup.matches.map((match) => `### ${match.link.filename} score=${match.score.toFixed(3)}\n${match.snippet}`).join("\n\n")}\n`);
			} else {
				const search = await this.search({ chain: loaded.link.chain, branch: loaded.link.branch, query: input.searchQuery, maxResults: input.maxSearchMatches ?? DEFAULT_CONTEXT_SEARCH_MATCHES, contextLines: 1, mode: searchMode });
				searchMatches = search.matches;
				if (searchMatches.length > 0) append(`\n## Search hits for ${JSON.stringify(input.searchQuery)}\n${searchMatches.map((match) => `### ${match.link.filename}:${match.line}\n${match.snippet}`).join("\n\n")}\n`);
			}
		}

		return { link: loaded.link, context: parts.join("\n"), truncated, includedLinks, searchMatches };
	}

	async links(chainName: string, branchName?: string): Promise<ChainLinkInfo[]> {
		const chain = validateChainName(chainName);
		const branch = branchName ? validateBranchName(branchName) : undefined;
		const dir = await this.ensureChainDir(chain, false);
		if (!dir) return [];
		let entries: Dirent<string>[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const filenames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort().reverse();
		const links = await Promise.all(filenames.map((filename) => this.linkInfo(chain, filename)));
		return branch ? links.filter((link) => link.branch === branch) : links;
	}

	private async latest(chain: string, branch?: string): Promise<ChainLinkInfo | null> {
		return (await this.links(chain, branch))[0] ?? null;
	}

	private async findLink(chain: string, filename: string): Promise<ChainLinkInfo | null> {
		try {
			return await this.linkInfo(chain, filename);
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	}

	private chainDir(chain: string): string {
		const root = resolve(this.root());
		const dir = resolve(root, chain);
		if (!dir.startsWith(`${root}/`) && dir !== root) throw new Error("Invalid chain path.");
		return dir;
	}

	private async ensureRootDir(create: true): Promise<string>;
	private async ensureRootDir(create: false): Promise<string | null>;
	private async ensureRootDir(create: boolean): Promise<string | null> {
		const root = resolve(this.root());
		if (create) await mkdir(root, { recursive: true });
		try {
			const stats = await lstat(root);
			if (stats.isSymbolicLink()) throw new Error("Refusing to use .chains because it is a symlink.");
			if (!stats.isDirectory()) throw new Error("Refusing to use .chains because it is not a directory.");
			const cwdReal = await realpath(this.cwd);
			const rootReal = await realpath(root);
			if (rootReal !== cwdReal && !rootReal.startsWith(`${cwdReal}/`)) throw new Error("Refusing to use .chains outside the project directory.");
			return root;
		} catch (error) {
			if (!create && isNotFound(error)) return null;
			throw error;
		}
	}

	private async ensureChainDir(chain: string, create: true): Promise<string>;
	private async ensureChainDir(chain: string, create: false): Promise<string | null>;
	private async ensureChainDir(chain: string, create: boolean): Promise<string | null> {
		const root = create ? await this.ensureRootDir(true) : await this.ensureRootDir(false);
		if (!root) return null;
		const dir = this.chainDir(chain);
		if (create) await mkdir(dir, { recursive: true });
		try {
			const stats = await lstat(dir);
			if (stats.isSymbolicLink()) throw new Error(`Refusing to use chain ${chain} because it is a symlink.`);
			if (!stats.isDirectory()) throw new Error(`Refusing to use chain ${chain} because it is not a directory.`);
			const rootReal = await realpath(root);
			const dirReal = await realpath(dir);
			if (dirReal !== rootReal && !dirReal.startsWith(`${rootReal}/`)) throw new Error("Refusing to use chain directory outside .chains.");
			return dir;
		} catch (error) {
			if (!create && isNotFound(error)) return null;
			throw error;
		}
	}

	private async lookupDocument(link: ChainLinkInfo): Promise<LookupDocument> {
		const raw = await this.readFullLinkContent(link.chain, link.filename);
		const content = stripFrontmatter(raw);
		const weightedContent = [
			weightedText(link.title, 4),
			weightedText(link.nextStep ?? "", 3),
			weightedText(preferredSections(content), 2),
			content,
		].join("\n");
		const terms = tokenize(weightedContent);
		const termFrequency = new Map<string, number>();
		for (const term of terms) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
		return { link, content, lines: content.split(/\r?\n/), termFrequency, length: Math.max(1, terms.length) };
	}

	private async readLinkContent(chain: string, filename: string, maxBytes: number): Promise<string> {
		const path = await this.safeLinkPath(chain, filename);
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.allocUnsafe(Math.max(1, maxBytes));
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	private async readFullLinkContent(chain: string, filename: string): Promise<string> {
		return this.readLinkContent(chain, filename, MAX_FULL_LINK_BYTES);
	}

	private async safeLinkPath(chain: string, filename: string): Promise<string> {
		const dir = await this.ensureChainDir(chain, false);
		if (!dir) throw Object.assign(new Error("Chain directory not found."), { code: "ENOENT" });
		const path = join(dir, validateLinkName(filename));
		const stats = await lstat(path);
		if (stats.isSymbolicLink()) throw new Error("Refusing to read chain link because it is a symlink.");
		if (!stats.isFile()) throw new Error("Chain link is not a file.");
		return path;
	}

	private async linkInfo(chain: string, filename: string): Promise<ChainLinkInfo> {
		const safeFilename = validateLinkName(filename);
		const path = await this.safeLinkPath(chain, safeFilename);
		const stats = await lstat(path);
		const content = await this.readLinkContent(chain, safeFilename, MAX_BYTES);
		const metadata = parseMetadata(content);
		const created = parseCreatedAt(safeFilename, metadata);
		return {
			chain,
			branch: metadata.branch && isValidSimpleName(metadata.branch) ? metadata.branch : DEFAULT_BRANCH,
			filename: safeFilename,
			path,
			title: extractTitle(content, safeFilename),
			nextStep: metadata.nextStep ?? null,
			parent: metadata.parent && isValidLinkName(metadata.parent) ? metadata.parent : null,
			createdAt: created.iso,
			ageDays: created.ageDays,
			stale: created.stale,
			bytes: stats.size,
		};
	}
}

export function validateChainName(value: string): string {
	const name = value.trim();
	if (!isValidSimpleName(name)) throw new Error("Invalid chain name. Use letters, numbers, dots, underscores, or hyphens; no slashes.");
	return name;
}

export function validateBranchName(value: string): string {
	const name = value.trim();
	if (!isValidSimpleName(name)) throw new Error("Invalid branch name. Use letters, numbers, dots, underscores, or hyphens; no slashes.");
	return name;
}

function isValidSimpleName(name: string): boolean {
	return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u.test(name) && !name.includes("..") && !name.startsWith(".");
}

export function validateLinkName(value: string): string {
	const name = value.trim();
	if (!isValidLinkName(name)) throw new Error("Invalid chain link filename.");
	return name;
}

function isValidLinkName(name: string): boolean {
	return /^[\p{L}\p{N}][\p{L}\p{N}._-]*\.md$/u.test(name) && !name.includes("..");
}

function normalizeContent(content: string): string {
	const text = content.trim();
	if (!text) throw new Error("Chain content is empty.");
	return `${text}\n`;
}

function timestamp(date = new Date()): string {
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(Math.floor(value), max));
}

function validateQuery(value: string): string {
	const query = value.trim();
	if (!query) throw new Error("Missing query.");
	if (query.length > MAX_QUERY_CHARS) throw new Error(`Query is too long; max ${MAX_QUERY_CHARS} characters.`);
	return query;
}

function clampFloat(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(value, max));
}

interface RankedSearchInput {
	query: string;
	chain?: string;
	branch?: string;
	maxResults?: number;
	recencyHalfLifeDays?: number;
	recencyWeight?: number;
}

interface RankedSearchMatch {
	link: ChainLinkInfo;
	score: number;
	lexicalScore: number;
	recencyScore: number;
	matchedTerms: string[];
	snippet: string;
}

interface RankedSearchResult {
	query: string;
	matches: RankedSearchMatch[];
	truncated: boolean;
}

interface LookupDocument {
	link: ChainLinkInfo;
	content: string;
	lines: string[];
	termFrequency: Map<string, number>;
	length: number;
}

function tokenize(value: string): string[] {
	return unicodeTerms(value);
}

function weightedText(text: string, weight: number): string {
	return Array.from({ length: Math.max(1, Math.floor(weight)) }, () => text).join("\n");
}

function preferredSections(content: string): string {
	const sections = content.split(/(?=^##\s+)/m).map((part) => part.trim()).filter(Boolean);
	return [...new Set([...sections.slice(0, 4), ...sections.slice(-2)])].join("\n\n");
}

function bm25Score(doc: LookupDocument, terms: string[], df: Map<string, number>, totalDocs: number, averageLength: number): number {
	const k1 = 1.4;
	const b = 0.75;
	let score = 0;
	for (const term of terms) {
		const termFrequency = doc.termFrequency.get(term) ?? 0;
		if (termFrequency <= 0) continue;
		const documentFrequency = df.get(term) ?? 0;
		const idf = Math.log(1 + (totalDocs - documentFrequency + 0.5) / (documentFrequency + 0.5));
		const denominator = termFrequency + k1 * (1 - b + b * (doc.length / averageLength));
		score += idf * ((termFrequency * (k1 + 1)) / denominator);
	}
	return score;
}

function phraseBoost(doc: LookupDocument, query: string): number {
	const needle = query.trim().toLowerCase();
	if (needle.length < 3) return 0;
	const title = doc.link.title.toLowerCase();
	const next = (doc.link.nextStep ?? "").toLowerCase();
	const body = doc.content.toLowerCase();
	return (title.includes(needle) ? 2 : 0) + (next.includes(needle) ? 1.25 : 0) + (body.includes(needle) ? 0.75 : 0);
}

function bestLookupSnippet(doc: LookupDocument, terms: string[]): string {
	let bestIndex = 0;
	let bestScore = -1;
	for (let index = 0; index < doc.lines.length; index++) {
		const tokens = tokenize(doc.lines[index] ?? "");
		const score = terms.reduce((sum, term) => sum + tokens.filter((token) => token === term).length, 0);
		if (score > bestScore) {
			bestScore = score;
			bestIndex = index;
		}
	}
	return snippet(doc.lines, bestIndex, 1);
}

function createMatcher(query: string, regex: boolean, caseSensitive: boolean): (line: string) => boolean {
	if (regex) {
		const flags = caseSensitive ? "" : "i";
		let pattern: RegExp;
		try {
			pattern = new RegExp(query, flags);
		} catch (error) {
			throw new Error(`Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
		}
		return (line) => pattern.test(line);
	}
	const needle = caseSensitive ? query : query.toLowerCase();
	return (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
}

function formatContextPack(input: { link: ChainLinkInfo; content: string; truncated: boolean }): string {
	return [`# Chain Context: ${input.link.chain}@${input.link.branch}/${input.link.filename}`, formatLinkBlock("Current link", input.link, input.content), input.truncated ? "[truncated]" : ""].filter(Boolean).join("\n\n");
}

function formatLinkBlock(label: string, link: ChainLinkInfo, content: string): string {
	return [`\n## ${label}: ${link.filename}`, `Title: ${link.title}`, `Parent: ${link.parent ?? "(none)"}`, `Next step: ${link.nextStep ?? "(not found)"}`, "", content.trim(), ""].join("\n");
}

function compactMarkdown(content: string): string {
	const body = stripFrontmatter(content).trim();
	const sections = body.split(/(?=^##\s+)/m).map((part) => part.trim()).filter(Boolean);
	const picked = [...new Set([...sections.slice(0, 3), ...sections.slice(-1)])];
	return picked.join("\n\n").replace(/\n{3,}/g, "\n\n") || body;
}

function snippet(lines: string[], index: number, context: number): string {
	const start = Math.max(0, index - context);
	const end = Math.min(lines.length, index + context + 1);
	return lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`).join("\n");
}

function branchInfos(chain: string, links: ChainLinkInfo[]): ChainBranchInfo[] {
	const byBranch = new Map<string, ChainLinkInfo[]>();
	for (const link of links) {
		const branch = byBranch.get(link.branch) ?? [];
		branch.push(link);
		byBranch.set(link.branch, branch);
	}
	return Array.from(byBranch.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([branch, branchLinks]) => ({ chain, branch, count: branchLinks.length, latest: branchLinks[0] ?? null }));
}
