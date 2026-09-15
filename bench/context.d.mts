export interface ContextSurface {
	surface: string;
	items: Array<{ item: string; bytes: number }>;
	total: number;
}

export interface ContextReport {
	generatedAt: string;
	tokenApproximation: string;
	surfaces: ContextSurface[];
	duplication: Array<{ sentence: string; matches: Array<{ source: string; shingles: string[] }> }>;
}

export function measure(): Promise<ContextReport>;
export function budgetViolations(report: ContextReport, budget: Record<string, number>): string[];
export function readBudget(): Record<string, number>;
