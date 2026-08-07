export type AgentMode = "advisory" | "executor";

export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	mode: AgentMode;
	write: boolean;
	model?: string;
	tags: string[];
	disabled: boolean;
	body: string;
}

/** `prompt` confirms every write-capable run, `worktree` trusts runs isolated in a dedicated git worktree, `always` trusts every run. */
export type DelegatedWritePolicy = "prompt" | "worktree" | "always";

export interface AgentsSettings {
	allowedModels: string[];
	defaultModel?: string;
	modelsByAgent: Record<string, string>;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	parallelDefaultConcurrency: number;
	parallelMaxConcurrency: number;
	delegatedWrites: DelegatedWritePolicy;
	worktreeRoot?: string;
	worktreeSetup: string[];
}
