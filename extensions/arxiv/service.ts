import { buildBibtex, parseArxivFeed } from "./parser.ts";
import type { ArxivBibtexInput, ArxivBibtexResult, ArxivGetInput, ArxivGetResult, ArxivPaper, ArxivSearchInput, ArxivSearchResult, ArxivSortBy, ArxivSortOrder } from "./types.ts";

const API_URL = "https://export.arxiv.org/api/query";
const USER_AGENT = "deevs-pi-kit/0.1 arxiv-extension";
const DEFAULT_MAX = 5;
const MAX_RESULTS_CAP = 25;
const MAX_ID_COUNT = 25;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_INTERVAL_MS = 3_000;

export class ArxivService {
	private lastRequestAt = 0;

	async search(input: ArxivSearchInput): Promise<ArxivSearchResult> {
		const maxResults = clampInt(input.maxResults ?? DEFAULT_MAX, 1, MAX_RESULTS_CAP);
		const start = clampInt(input.start ?? 0, 0, 10_000);
		const sortBy = parseSortBy(input.sortBy);
		const sortOrder = parseSortOrder(input.sortOrder);
		const searchQuery = buildSearchQuery(input);
		if (!searchQuery) throw new Error("arxiv_search requires query, title, author, abstract, or category");
		const url = buildUrl({ search_query: searchQuery, start: String(start), max_results: String(maxResults), sortBy, sortOrder });
		const feed = parseArxivFeed(await this.fetchText(url));
		return { query: searchQuery, url, totalResults: feed.totalResults, start, maxResults, papers: feed.papers, truncated: feed.papers.length >= maxResults };
	}

	async get(input: ArxivGetInput): Promise<ArxivGetResult> {
		const ids = normalizeIds(input.ids);
		const url = buildUrl({ id_list: ids.join(","), max_results: String(ids.length) });
		const feed = parseArxivFeed(await this.fetchText(url));
		const papers = input.includeBibtex ? feed.papers.map((paper) => ({ ...paper, bibtex: buildBibtex(paper) })) : feed.papers;
		const found = new Set(papers.flatMap((paper) => [paper.id.toLowerCase(), paper.baseId.toLowerCase()]));
		const missing = ids.filter((id) => !found.has(id.toLowerCase()) && !found.has(id.replace(/v\d+$/i, "").toLowerCase()));
		return { ids, url, papers, missing };
	}

	async bibtex(input: ArxivBibtexInput): Promise<ArxivBibtexResult> {
		const result = await this.get({ ids: input.ids });
		return { ids: result.ids, entries: result.papers.map(buildBibtex), missing: result.missing };
	}

	private async fetchText(url: string): Promise<string> {
		const now = Date.now();
		const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - this.lastRequestAt));
		if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
		this.lastRequestAt = Date.now();

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
			if (!response.ok) throw new Error(`arXiv API HTTP ${response.status}: ${response.statusText}`);
			return await response.text();
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw new Error(`arXiv API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

function buildSearchQuery(input: ArxivSearchInput): string {
	const parts: string[] = [];
	if (input.query?.trim()) parts.push(fieldTerms("all", input.query));
	if (input.title?.trim()) parts.push(fieldPhrase("ti", input.title));
	if (input.author?.trim()) parts.push(fieldPhrase("au", input.author));
	if (input.abstract?.trim()) parts.push(fieldTerms("abs", input.abstract));
	if (input.category?.trim()) parts.push(`cat:${input.category.trim()}`);
	return parts.join(" AND ");
}

function fieldPhrase(field: string, value: string): string {
	const query = value.trim();
	if (advancedQuery(query)) return `${field}:${query}`;
	return /\s/.test(query) ? `${field}:"${query.replace(/"/g, "")}"` : `${field}:${query}`;
}

function fieldTerms(field: string, value: string): string {
	const query = value.trim();
	if (advancedQuery(query)) return `${field}:${query}`;
	const terms = query.split(/\s+/).filter(Boolean).map((term) => term.replace(/["()]/g, ""));
	return terms.map((term) => `${field}:${term}`).join(" AND ");
}

function advancedQuery(query: string): boolean {
	return /\b(AND|OR|ANDNOT)\b|[":()]/i.test(query);
}

function buildUrl(params: Record<string, string>): string {
	const url = new URL(API_URL);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

function normalizeIds(ids: string[] | string): string[] {
	const list = Array.isArray(ids) ? ids : ids.split(/[\s,]+/);
	const normalized = [...new Set(list.map((id) => id.trim().replace(/^arXiv:/i, "")).filter(Boolean))];
	if (!normalized.length) throw new Error("At least one arXiv id is required");
	if (normalized.length > MAX_ID_COUNT) throw new Error(`At most ${MAX_ID_COUNT} ids are allowed per request`);
	for (const id of normalized) {
		if (!/^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(id)) throw new Error(`Invalid arXiv id: ${id}`);
	}
	return normalized;
}

function clampInt(value: number, min: number, max: number): number {
	const n = Number.isFinite(value) ? Math.floor(value) : min;
	return Math.min(max, Math.max(min, n));
}

function parseSortBy(value: ArxivSortBy | undefined): ArxivSortBy {
	if (!value) return "relevance";
	if (["relevance", "lastUpdatedDate", "submittedDate"].includes(value)) return value;
	throw new Error(`Invalid sortBy: ${value}`);
}

function parseSortOrder(value: ArxivSortOrder | undefined): ArxivSortOrder {
	if (!value) return "descending";
	if (["ascending", "descending"].includes(value)) return value;
	throw new Error(`Invalid sortOrder: ${value}`);
}

export function formatPaperLine(paper: ArxivPaper, index?: number): string {
	const prefix = index === undefined ? "" : `${index}. `;
	return `${prefix}[${paper.id}] ${paper.title}\n   Authors: ${paper.authors.join(", ") || "(unknown)"}\n   Published: ${paper.published.slice(0, 10)} | Updated: ${paper.updated.slice(0, 10)} | Categories: ${paper.categories.join(", ") || "(none)"}\n   ${paper.absUrl}\n   PDF: ${paper.pdfUrl}\n   Abstract: ${truncate(paper.summary, 500)}`;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
