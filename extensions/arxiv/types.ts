export type ArxivSortBy = "relevance" | "lastUpdatedDate" | "submittedDate";
export type ArxivSortOrder = "ascending" | "descending";

export interface ArxivSearchInput {
	query?: string;
	title?: string;
	author?: string;
	abstract?: string;
	category?: string;
	start?: number;
	maxResults?: number;
	sortBy?: ArxivSortBy;
	sortOrder?: ArxivSortOrder;
}

export interface ArxivGetInput {
	ids: string[] | string;
	includeBibtex?: boolean;
}

export interface ArxivBibtexInput {
	ids: string[] | string;
}

export interface ArxivPaper {
	id: string;
	version: string | null;
	baseId: string;
	title: string;
	authors: string[];
	summary: string;
	published: string;
	updated: string;
	categories: string[];
	primaryCategory: string | null;
	doi: string | null;
	comment: string | null;
	journalRef: string | null;
	absUrl: string;
	pdfUrl: string;
	bibtex?: string;
}

export interface ArxivSearchResult {
	query: string;
	url: string;
	totalResults: number | null;
	start: number;
	maxResults: number;
	papers: ArxivPaper[];
	truncated: boolean;
}

export interface ArxivGetResult {
	ids: string[];
	url: string;
	papers: ArxivPaper[];
	missing: string[];
}

export interface ArxivBibtexResult {
	ids: string[];
	entries: string[];
	missing: string[];
}
