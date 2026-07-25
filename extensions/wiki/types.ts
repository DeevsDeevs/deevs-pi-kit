export type WikiSearchMode = "lookup" | "text" | "regex";
export type WikiIssueSeverity = "error" | "warning" | "notice";

export interface WikiInitInput {
	path: string;
	domain: string;
	title?: string;
	dryRun?: boolean;
}

export interface WikiStatusInput {
	path: string;
	maxIssues?: number;
}

export interface WikiLintInput {
	path: string;
	maxIssues?: number;
	includeWarnings?: boolean;
}

export interface WikiGraphInput {
	path: string;
	includeOrphans?: boolean;
	includeBacklinks?: boolean;
	maxNodes?: number;
	maxEdges?: number;
}

export interface WikiSearchInput {
	path: string;
	query: string;
	mode?: WikiSearchMode;
	maxResults?: number;
	contextLines?: number;
	caseSensitive?: boolean;
}

export interface WikiContextInput {
	path: string;
	query?: string;
	pages?: string[];
	searchMode?: WikiSearchMode;
	maxPages?: number;
	includeBacklinks?: boolean;
	includeForwardLinks?: boolean;
	maxBytes?: number;
	compact?: boolean;
}

export interface WikiInitResult {
	path: string;
	dryRun: boolean;
	created: string[];
}

export interface WikiPageInfo {
	id: string;
	path: string;
	relativePath: string;
	title: string;
	type: string | null;
	tags: string[];
	sources: string[];
	confidence: string | null;
	contested: boolean;
	bytes: number;
	lines: number;
}

export interface WikiGraphNode extends WikiPageInfo {}

export interface WikiGraphEdge {
	from: string;
	to: string;
	raw: string;
}

export interface WikiBrokenLink {
	from: string;
	target: string;
	raw: string;
	line: number;
}

export interface WikiAmbiguousLink {
	from: string;
	target: string;
	candidates: string[];
	raw: string;
	line: number;
}

export interface WikiGraphResult {
	path: string;
	nodes: WikiGraphNode[];
	edges: WikiGraphEdge[];
	orphans: WikiGraphNode[];
	brokenLinks: WikiBrokenLink[];
	ambiguousLinks: WikiAmbiguousLink[];
	backlinks?: Record<string, string[]>;
	truncated: boolean;
}

export interface WikiIssue {
	severity: WikiIssueSeverity;
	code: string;
	message: string;
	path?: string;
}

export interface WikiLintResult {
	path: string;
	issues: WikiIssue[];
	truncated: boolean;
	summary: Record<WikiIssueSeverity, number>;
}

export interface WikiStatusResult {
	path: string;
	coreFiles: Record<string, boolean>;
	coreDirs: Record<string, boolean>;
	pageCount: number;
	sourceCount: number;
	pageCountsByType: Record<string, number>;
	latestLogEntry: string | null;
	graph: {
		nodes: number;
		edges: number;
		orphans: number;
		brokenLinks: number;
		ambiguousLinks: number;
	};
	issues: WikiIssue[];
}

export interface WikiSearchMatch {
	page: WikiPageInfo;
	line: number;
	snippet: string;
	score?: number;
	matchedTerms?: string[];
}

export interface WikiSearchResult {
	path: string;
	query: string;
	mode: WikiSearchMode;
	matches: WikiSearchMatch[];
	truncated: boolean;
}

export interface WikiContextResult {
	path: string;
	context: string;
	pages: WikiPageInfo[];
	searchMatches: WikiSearchMatch[];
	truncated: boolean;
}
