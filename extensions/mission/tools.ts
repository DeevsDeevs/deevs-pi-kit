import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, updateMissionSummaryArtifact, writeCompletionAudit } from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import type { MissionCompleteInput, MissionCreateInput } from "./types.ts";

const CreateSchema = Type.Object({
	objective: Type.String({ description: "Full mission objective and requirements to pursue until complete, paused, cleared, or budget-limited" }),
	title: Type.Optional(Type.String({ description: "Short human-readable mission name; recommended for long objectives" })),
	requirements: Type.Optional(Type.Array(Type.String(), { description: "Optional decomposed requirements/success criteria from the objective" })),
	tokenBudget: Type.Optional(Type.Number({ description: "Optional positive token budget for the mission" })),
	costBudgetUsd: Type.Optional(Type.Number({ description: "Optional positive USD cost budget for the mission" })),
	chain: Type.Optional(Type.String({ description: "Optional chain name; if omitted Mission auto-binds to a matching or derived chain" })),
	chainBranch: Type.Optional(Type.String({ description: "Chain branch; defaults to main" })),
});

const GetSchema = Type.Object({});

const AuditItemSchema = Type.Object({
	requirement: Type.String({ description: "Requirement or success criterion" }),
	evidence: Type.String({ description: "Concrete evidence that satisfies the requirement" }),
});

const CompleteSchema = Type.Object({
	summary: Type.Optional(Type.String({ description: "Concise completion summary" })),
	audit: Type.Optional(Type.Array(AuditItemSchema, { description: "Requirement-to-evidence completion audit" })),
});

export function registerMissionTools(pi: ExtensionAPI, state: MissionState, setContext: (ctx: ExtensionContext) => void): void {
	(pi as any).registerTool({
		name: "mission_get",
		label: "Get Mission",
		description: "Get the current branch-scoped Pi mission, including status, chain binding, budgets, usage, and artifact path.",
		promptSnippet: "Read the active branch-scoped mission.",
		parameters: GetSchema as any,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const mission = state.readAny();
			const usage = state.readUsage();
			return { content: [{ type: "text" as const, text: formatMission(mission, usage) }], details: { mission, usage } };
		},
	});

	(pi as any).registerTool({
		name: "mission_create",
		label: "Create Mission",
		description: "Create a persistent branch-scoped mission only when explicitly requested by the user or system/developer instructions.",
		promptSnippet: "Create a persistent mission objective for this branch.",
		promptGuidelines: [
			"Use mission_create only when the user explicitly asks for a mission/goal/objective that should continue across turns.",
			"For long or multi-part objectives, provide a concise title and decomposed requirements; ask the user only if the name/scope is ambiguous.",
			"Set tokenBudget or costBudgetUsd only when the user explicitly requests a budget.",
			"Mission auto-binds to a short title-derived chain if chain is omitted and creates .missions artifacts.",
		],
		parameters: CreateSchema as any,
		async execute(_toolCallId, params: MissionCreateInput, _signal, _onUpdate, ctx) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const event = await state.create(params, ctx);
			const mission = state.append(pi, event)!;
			await initializeMissionArtifacts(ctx.cwd, mission, state.readUsage());
			return { content: [{ type: "text" as const, text: `Mission created: ${mission.title}\nChain: ${mission.chain}@${mission.chainBranch}\nArtifacts: ${mission.artifactDir}` }], details: { mission, usage: state.readUsage() } };
		},
	});

	(pi as any).registerTool({
		name: "mission_complete",
		label: "Complete Mission",
		description: "Mark the active mission complete only after auditing objective requirements against concrete evidence.",
		promptSnippet: "Complete the active mission after a concrete completion audit.",
		promptGuidelines: [
			"Use mission_complete only when the mission objective is actually achieved and no required work remains.",
			"Do not use mission_complete because budget is exhausted, work is paused, or progress is partial.",
			"Include a concise summary and, when possible, requirement-to-evidence audit items.",
		],
		parameters: CompleteSchema as any,
		async execute(_toolCallId, params: MissionCompleteInput, _signal, _onUpdate, ctx) {
			setContext(ctx);
			state.loadFromSession(ctx);
			const event = state.statusEvent("complete", "mission_complete called", params.summary);
			const mission = state.append(pi, event)!;
			const usage = state.readUsage();
			await writeCompletionAudit(mission, params.summary, params.audit, usage);
			await updateMissionSummaryArtifact(mission, usage);
			return { content: [{ type: "text" as const, text: `Mission complete: ${mission.title}\nUsage: ${usage.totalTokens} tokens, $${usage.totalCostUsd.toFixed(4)}\nArtifacts: ${mission.artifactDir}` }], details: { mission, usage, audit: params.audit } };
		},
	});
}

export function formatMission(mission: ReturnType<MissionState["readAny"]>, usage: ReturnType<MissionState["readUsage"]>): string {
	if (!mission) return "No active mission on this branch.";
	const budget = [
		mission.tokenBudget ? `${usage.totalTokens}/${mission.tokenBudget} tokens` : `${usage.totalTokens} tokens`,
		mission.costBudgetUsd ? `$${usage.totalCostUsd.toFixed(4)}/$${mission.costBudgetUsd}` : `$${usage.totalCostUsd.toFixed(4)}`,
	].join(", ");
	const requirements = mission.requirements.length
		? [`Requirements:`, ...mission.requirements.map((item) => `- ${item}`)]
		: [];
	return [
		`${mission.missionId} [${mission.status}] ${mission.title}`,
		mission.objective !== mission.title ? `Objective: ${mission.objective}` : undefined,
		...requirements,
		`Budget/usage: ${budget}`,
		`Chain: ${mission.chain}@${mission.chainBranch}`,
		`Artifacts: ${mission.artifactDir}`,
		mission.lastReason ? `Reason: ${mission.lastReason}` : undefined,
	].filter(Boolean).join("\n");
}
