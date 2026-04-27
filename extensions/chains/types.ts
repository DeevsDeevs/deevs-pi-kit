export interface ChainLinkInfo {
	chain: string;
	branch: string;
	filename: string;
	path: string;
	title: string;
	nextStep: string | null;
	parent: string | null;
	createdAt: string | null;
	ageDays: number | null;
	stale: boolean;
	bytes: number;
}

export interface ChainBranchInfo {
	chain: string;
	branch: string;
	count: number;
	latest: ChainLinkInfo | null;
}

export interface ChainListItem {
	chain: string;
	count: number;
	latest: ChainLinkInfo | null;
	branches?: ChainBranchInfo[];
	links?: ChainLinkInfo[];
}

export interface ChainSaveInput {
	chain: string;
	content: string;
	title?: string;
	slug?: string;
	branch?: string;
	parent?: string;
}

export interface ChainLoadInput {
	chain: string;
	branch?: string;
	link?: string;
	maxBytes?: number;
}

export interface ChainListInput {
	includeLinks?: boolean;
	includeBranches?: boolean;
}

export interface ChainForkInput {
	chain: string;
	branch: string;
	from?: string;
	fromBranch?: string;
}

export interface ChainSearchInput {
	query: string;
	chain?: string;
	branch?: string;
	maxResults?: number;
	contextLines?: number;
	regex?: boolean;
	caseSensitive?: boolean;
}

export interface ChainContextInput extends ChainLoadInput {
	mode?: "latest" | "pack";
	includeParents?: number;
	recentLinks?: number;
	searchQuery?: string;
	maxSearchMatches?: number;
	compact?: boolean;
}

export interface ChainLoadResult {
	link: ChainLinkInfo;
	content: string;
	truncated: boolean;
	recent: ChainLinkInfo[];
}

export interface ChainSaveResult {
	link: ChainLinkInfo;
}

export interface ChainForkResult {
	chain: string;
	branch: string;
	parent: ChainLinkInfo;
	prompt: string;
}

export interface ChainSearchMatch {
	link: ChainLinkInfo;
	line: number;
	snippet: string;
}

export interface ChainSearchResult {
	query: string;
	matches: ChainSearchMatch[];
	truncated: boolean;
	regex: boolean;
}

export interface ChainContextResult {
	link: ChainLinkInfo;
	context: string;
	truncated: boolean;
	includedLinks: ChainLinkInfo[];
	searchMatches: ChainSearchMatch[];
}

