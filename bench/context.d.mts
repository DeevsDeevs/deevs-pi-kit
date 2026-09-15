export interface ContextItem {
	item: string;
	text: string;
	bytes: number;
	tokens: number;
	claudeTokens?: number;
}

export interface ContextSurface {
	surface: string;
	items: ContextItem[];
	total: number;
	claudeTotal?: number;
}

export interface ContextReport {
	generatedAt: string;
	tokenizers: Record<string, string>;
	surfaces: ContextSurface[];
	duplication: Array<{ sentence: string; tokens: number; matches: Array<{ source: string; shingles: string[] }> }>;
}

export function measure(): Promise<ContextReport>;
export function claudeTokens(report: ContextReport, options?: { refresh?: boolean }): number;
export function budgetViolations(report: ContextReport, budget: Record<string, number>): string[];
export function readBudget(): Record<string, number>;
