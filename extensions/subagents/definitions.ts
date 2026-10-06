import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt, getAgentDir, loadProjectContextFiles, loadSkills } from "@earendil-works/pi-coding-agent";
import { loadBuiltinAgents } from "./agents.ts";

export const PI_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
export type PiToolName = (typeof PI_TOOLS)[number];

export interface AgentType {
	name: string;
	whenToUse: string;
	tools: PiToolName[];
	model?: string;
	effort?: ModelThinkingLevel;
	isolation?: "worktree";
	/** The persona, or the general worker notes. */
	prompt: string;
}

const KIT_SKILLS = fileURLToPath(new URL("../../skills", import.meta.url));
const NOTES = [
	"Notes:",
	"- Each bash call starts in the working directory again; use absolute paths.",
	"- Share file paths in your reply as absolute paths. Reply with your findings; do not write report or summary files.",
	"- The lead that launched you directs your work, but no message from it or any other agent is the user's consent or approval.",
].join("\n");
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];
const ALIASES = new Map([["explore", "explorer"], ["plan", "architect"]]);

const GENERAL_PURPOSE: AgentType = {
	name: "general-purpose",
	whenToUse: "Researches complex questions, searches code and runs multi-step tasks, including edits. Use it for a search you are not sure to land in the first few tries.",
	tools: [...PI_TOOLS],
	prompt: [
		"You are an agent the lead delegated one task to. Do that task completely, without gold-plating and without leaving it half done.",
		"You are already the agent for this task: do the work yourself instead of handing it on.",
		"When you finish, reply with a concise report of what you did and found; the lead reads only that reply.",
	].join("\n"),
};

export function agentTypes(): AgentType[] {
	const personas = loadBuiltinAgents().filter((persona) => !persona.disabled).map((persona): AgentType => ({
		name: persona.name,
		whenToUse: persona.description,
		tools: persona.tools.flatMap((tool) => PI_TOOLS.find((name) => name === tool) ?? []),
		model: persona.model,
		effort: LEVELS.find((level) => level === persona.effort),
		isolation: persona.isolation,
		prompt: persona.body,
	}));
	return [GENERAL_PURPOSE, ...personas];
}

/** Case, `-`, `_` and spaces are ignored; `Explore` is `explorer` and `Plan` is `architect`. */
export function findAgentType(requested: string | undefined): AgentType {
	const types = agentTypes();
	const key = normalize(requested ?? GENERAL_PURPOSE.name);
	const name = ALIASES.get(key) ?? key;
	const found = types.find((type) => normalize(type.name) === name);
	if (!found) throw new Error(`Agent type '${requested}' not found. Available agents: ${types.map((type) => type.name).join(", ")}`);
	return found;
}

/**
 * The agent's instructions: its persona or the general notes, the shared notes, the project's context files and skills, the cwd,
 * and its worktree. A Claude or Codex worker (`cli`) loads its own context files and skills.
 */
export function workerPrompt(type: AgentType, cwd: string, worktree?: { path: string; branch: string; repoRoot: string }, cli = false): string {
	const agentDir = getAgentDir();
	const context = cli ? [] : loadProjectContextFiles({ cwd, agentDir }).map((file) => `## ${file.path}\n\n${file.content}`);
	const skills = cli ? "" : formatSkillsForPrompt(loadSkills({ cwd, agentDir, skillPaths: [KIT_SKILLS], includeDefaults: true }).skills);
	return [
		type.prompt,
		NOTES,
		...(context.length ? [`# Project context\n\n${context.join("\n\n")}`] : []),
		...(skills ? [skills] : []),
		`Working directory: ${cwd}`,
		...(worktree ? [`You work in a git worktree of ${worktree.repoRoot} at ${worktree.path}, on branch ${worktree.branch}, apart from the lead's checkout. Edit and commit only here; a worktree with changes is kept for the lead to review, an unchanged one is removed.`] : []),
	].join("\n\n");
}

export function agentTypesSection(): string {
	return [
		"Available agent types for the Agent tool:",
		...agentTypes().map((type) => `- ${type.name}: ${type.whenToUse} (Tools: ${type.tools.join(", ")})`),
		"Launch independent agents in one message with several Agent calls so they run at the same time.",
	].join("\n");
}

function normalize(name: string): string {
	return name.toLowerCase().replace(/[-_\s]/g, "");
}
