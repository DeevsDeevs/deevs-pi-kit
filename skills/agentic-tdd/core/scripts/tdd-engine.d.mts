export interface InitOptions {
	mode?: string;
	title?: string;
	protection?: string;
	challenges?: string[];
	testCommand?: string;
	allowDirty?: boolean;
	models?: Record<string, string>;
}

export interface Manifest {
	schema_version: number;
	feature: { id: string; title: string; mode: string };
	workflow: { state: string; required_next: string[] };
	repository: {
		baseline_commit: string;
		candidate_commit: string | null;
		branch: string;
		test_command: string | null;
		untracked_at_init: string[];
	};
	current: { plan_version: string | null; loop_run: string | null; assessment_run: string | null };
	options: {
		protection_mode: string;
		challenges: { plan: boolean; loop: boolean; assess: boolean };
		models: Record<string, string>;
	};
	integrity: Record<string, unknown>;
	budgets: Record<string, number>;
	user_decisions: { unresolved_blocking: number };
	challenges: Record<string, string>;
	release: { reviewer_status: string };
}

export interface VerifyReport {
	ok: boolean;
	state: string;
	problems: Array<{ code: string; path?: string; phase?: string; expected?: string; actual?: string }>;
	untracked: string[];
	modified: string[];
}

export declare const TRANSITIONS: Record<string, string[]>;
export declare function init(root: string, feature: string, options?: InitOptions): Manifest;
export declare function transition(root: string, feature: string, to: string, options?: { resultFile?: string }): { from: string; to: string; state: string };
export declare function freeze(root: string, feature: string, phase: string, files: string[]): { commit: string; files: Record<string, string> };
export declare function protect(root: string, feature: string, files: string[]): Array<{ path: string; hash: string; method: string }>;
export declare function unprotect(root: string, feature: string): { released: number };
export declare function verify(root: string, feature: string): VerifyReport;
export declare function consumeBudget(root: string, feature: string, counter: string): { counter: string; remaining: number };
export declare function status(root: string, feature: string): { state: string; allowed_next: string[] } & Record<string, unknown>;
export declare function appendEvent(root: string, feature: string, type: string, data?: Record<string, unknown>): Record<string, unknown>;
