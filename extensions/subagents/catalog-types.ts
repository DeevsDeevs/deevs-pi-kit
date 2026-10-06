export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	disabled: boolean;
	effort?: string;
	isolation?: "worktree";
	body: string;
}
