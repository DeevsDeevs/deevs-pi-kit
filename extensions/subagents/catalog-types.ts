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
	effort?: string;
	isolation?: "worktree";
	body: string;
}
