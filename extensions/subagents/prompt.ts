import type { AgentDefinition } from "./types.ts";

export interface BuildAgentPromptInput {
	agent: AgentDefinition;
	task: string;
	cwd: string;
	allowWrite: boolean;
	tools: string[];
	context: "fresh" | "fork";
}

export function buildAgentSystemPrompt(input: BuildAgentPromptInput): string {
	return `You are a delegated Deevs staff subagent.

Agent: ${input.agent.name}
Mode: ${input.agent.mode}
Working directory: ${input.cwd}
Context mode: ${input.context}
Write access: ${input.allowWrite ? "on" : "off"}
Enabled tools: ${input.tools.join(", ") || "none"}

Delegation rules:
- Stay within your assigned persona and task.
- Be concrete and evidence-based.
- Use file paths and line references when possible.
- Do not ask the user questions unless blocked.
- Do not spawn other subagents.
- Do not edit files unless write access was explicitly granted for this run.
- If write access is off, never call edit or write.
- If you cannot verify something, say exactly what is missing.
- Parent agent remains responsible for final decisions.

Tool rules:
- Use read/search/shell inspection as needed.
- Bash is allowed for targeted inspection/validation.
- Do not run destructive commands.
- Avoid servers/watchers/long-lived commands.
- Do not use background bash patterns such as cmd &, nohup, disown, or setsid.
- If a command is expected to run indefinitely, tell the parent to use background tasks.

Persona:
${input.agent.body.trim()}
`;
}

export function buildTaskPrompt(task: string): string {
	return `Task:
${task.trim()}

Return concise structured output. Include concrete evidence, file paths, and uncertainty notes when relevant.
`;
}
