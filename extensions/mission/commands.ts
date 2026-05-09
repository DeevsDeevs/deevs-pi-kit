import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, updateMissionSummaryArtifact, writeCompletionAudit } from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import { formatMission } from "./tools.ts";
import type { MissionCreateInput, MissionStatus } from "./types.ts";

export function registerMissionCommands(pi: ExtensionAPI, state: MissionState, setContext: (ctx: ExtensionContext) => void, maybeContinue: (ctx: ExtensionContext) => void): void {
	pi.registerCommand("mission", {
		description: "Create/manage a branch-scoped mission: /mission <objective> [--name title] [--budget 200k] [--cost $2] [--chain name] | status|pause|resume|complete|clear",
		handler: async (args, ctx) => {
			setContext(ctx);
			state.loadFromSession(ctx);
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status" || trimmed === "show") {
				ctx.ui.notify(formatMission(state.read(), state.readUsage()), "info");
				return;
			}

			const command = trimmed.toLowerCase();
			if (["pause", "resume", "clear"].includes(command)) {
				const status = command === "pause" ? "paused" : command === "resume" ? "active" : "cleared";
				await setStatus(pi, state, status, ctx, `/${command}`);
				if (status === "active") maybeContinue(ctx);
				return;
			}
			if (command === "complete" || command === "end" || command === "stop") {
				await completeByUserRequest(pi, state, ctx, `/mission ${command}`);
				return;
			}

			try {
				const input = parseCreateArgs(trimmed);
				const event = await state.create(input, ctx);
				const mission = state.append(pi, event)!;
				await initializeMissionArtifacts(ctx.cwd, mission, state.readUsage());
				ctx.ui.notify(`Mission created: ${mission.title}\nChain: ${mission.chain}@${mission.chainBranch}\nArtifacts: ${mission.artifactDir}`, "info");
				maybeContinue(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function setStatus(pi: ExtensionAPI, state: MissionState, status: MissionStatus, ctx: ExtensionContext, reason: string): Promise<void> {
	try {
		const event = state.statusEvent(status, reason);
		const mission = state.append(pi, event);
		if (mission) await updateMissionSummaryArtifact(mission, state.readUsage());
		ctx.ui.notify(formatMission(mission, state.readUsage()), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function completeByUserRequest(pi: ExtensionAPI, state: MissionState, ctx: ExtensionContext, reason: string): Promise<void> {
	try {
		const summary = "Mission ended at explicit user request. Use /mission resume to continue if needed.";
		const event = state.statusEvent("complete", reason, summary);
		const mission = state.append(pi, event);
		if (!mission) return;
		const usage = state.readUsage();
		await writeCompletionAudit(mission, summary, [{ requirement: "User-requested mission end", evidence: "The user explicitly asked to end/complete the mission; this records closure without claiming all objective requirements are satisfied. Use /mission resume to continue if needed." }], usage);
		await updateMissionSummaryArtifact(mission, usage);
		ctx.ui.notify(`${formatMission(mission, usage)}\nResume: /mission resume`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

function parseCreateArgs(input: string): MissionCreateInput {
	const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const objectiveParts: string[] = [];
	const result: MissionCreateInput = { objective: "" };
	for (let i = 0; i < tokens.length; i += 1) {
		const token = unquote(tokens[i]!);
		if (token === "--budget" || token === "--tokens" || token === "--token-budget") result.tokenBudget = parseBudget(tokens[++i], token);
		else if (token.startsWith("--budget=")) result.tokenBudget = parseBudget(token.slice("--budget=".length), "--budget");
		else if (token === "--cost") result.costBudgetUsd = parseCost(tokens[++i]);
		else if (token.startsWith("--cost=")) result.costBudgetUsd = parseCost(token.slice("--cost=".length));
		else if (token === "--name" || token === "--title") result.title = unquote(tokens[++i] ?? "");
		else if (token.startsWith("--name=")) result.title = token.slice("--name=".length);
		else if (token.startsWith("--title=")) result.title = token.slice("--title=".length);
		else if (token === "--requirement" || token === "--req") (result.requirements ??= []).push(unquote(tokens[++i] ?? ""));
		else if (token.startsWith("--requirement=")) (result.requirements ??= []).push(token.slice("--requirement=".length));
		else if (token.startsWith("--req=")) (result.requirements ??= []).push(token.slice("--req=".length));
		else if (token === "--chain") result.chain = unquote(tokens[++i] ?? "");
		else if (token.startsWith("--chain=")) result.chain = token.slice("--chain=".length);
		else if (token === "--branch" || token === "--chain-branch") result.chainBranch = unquote(tokens[++i] ?? "");
		else objectiveParts.push(token);
	}
	result.objective = objectiveParts.join(" ").trim();
	return result;
}

function parseBudget(raw: string | undefined, flag: string): number {
	if (!raw) throw new Error(`${flag} requires a value`);
	const text = unquote(raw).toLowerCase().replace(/,/g, "");
	const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(text);
	if (!match) throw new Error(`Invalid token budget: ${raw}`);
	const value = Number(match[1]);
	const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	return Math.round(value * multiplier);
}

function parseCost(raw: string | undefined): number {
	if (!raw) throw new Error("--cost requires a value");
	const value = Number(unquote(raw).replace(/^\$/, ""));
	if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid cost budget: ${raw}`);
	return value;
}

function unquote(value: string): string {
	return value.replace(/^(["'])(.*)\1$/, "$2");
}
