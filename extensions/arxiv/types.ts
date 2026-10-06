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
