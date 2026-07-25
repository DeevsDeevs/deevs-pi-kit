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

export interface AgentsSettings {
	allowedModels: string[];
	defaultModel?: string;
	modelsByAgent: Record<string, string>;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	parallelDefaultConcurrency: number;
	parallelMaxConcurrency: number;
}
