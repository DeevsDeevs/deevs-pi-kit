import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, updateMissionSummaryArtifact } from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import { listSnapshotTakeoverCandidates } from "./takeover.ts";
import { completeMission, formatContinuation, formatMission, resumeMission, takeoverMission, updateMission } from "./tools.ts";
import type { MissionCompleteInput, MissionCreateInput, MissionCurrent, MissionStatus, MissionTakeoverCandidate, MissionUpdateInput } from "./types.ts";
import { showTextViewer } from "../shared/text-viewer.ts";
import { chainCheckpoints } from "../chains/checkpoint.ts";
import { FULL_SCREEN_OVERLAY } from "../shared/dashboard.ts";
import { MissionDashboard } from "./ui.ts";

export function registerMissionCommands(pi: ExtensionAPI, state: MissionState, setContext: (ctx: ExtensionContext) => void, maybeContinue: (ctx: ExtensionContext) => void, hooks: { validateCompletion?: (input: MissionCompleteInput, ctx: ExtensionContext, directUserRequest?: boolean) => Promise<string[]> | string[]; authorizeCompletion?: (ctx: ExtensionContext) => Promise<string>; completionCandidateId?: (ctx: ExtensionContext) => Promise<string | undefined>; onCreated?: (ctx: ExtensionContext) => void; onTakenOver?: (ctx: ExtensionContext, mission: MissionCurrent) => void; discoverTakeoverCandidates?: (ctx: ExtensionContext) => Promise<MissionTakeoverCandidate[]>; onChanged?: (ctx: ExtensionContext) => void; onResumed?: (ctx: ExtensionContext) => void; continuationBlockers?: (ctx: ExtensionContext) => string[]; onObjectiveUpdated?: (input: MissionUpdateInput, ctx: ExtensionContext) => void; onCompleted?: (ctx: ExtensionContext, mission: MissionCurrent, completionId?: string) => Promise<void> | void } = {}): void {
	pi.registerCommand("mission", {
		description: "Create/manage a durable single-controller Mission.",
		handler: async (args, ctx) => {
			setContext(ctx);
			state.loadFromSession(ctx);
			const trimmed = args.trim();
			if (!trimmed || trimmed === "status" || trimmed === "show") {
				if (ctx.mode === "tui" && ctx.hasUI && state.readAny()) {
					await showMissionDashboard(pi, state, ctx, setContext, maybeContinue, hooks);
				} else await showTextViewer(ctx, "Mission", formatMission(state.readAny(), state.readUsage()));
				return;
			}

			const command = trimmed.toLowerCase();
			if (command === "takeover" || command.startsWith("takeover ")) {
				try {
					const selector = trimmed.slice("takeover".length).trim();
					const mission = await takeoverMission(pi, state, ctx, { missionId: selector, reason: "/mission takeover" }, hooks, true);
					ctx.ui.notify(`Mission taken over${mission.status === "active" ? " and resumed" : ""}:\n${formatMission(mission, state.readUsage())}`, "info");
					maybeContinue(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (["pause", "resume", "clear"].includes(command)) {
				if (command === "resume") {
					try {
						const mission = await resumeMission(pi, state, "/resume");
						hooks.onResumed?.(ctx);
						maybeContinue(ctx);
						ctx.ui.notify(`${formatMission(mission, state.readUsage())}${formatContinuation(hooks.continuationBlockers?.(ctx) ?? [])}`, "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				const status = command === "pause" ? "paused" : "cleared";
				await setStatus(pi, state, status, ctx, `/${command}`);
				if (status === "paused") chainCheckpoints.current?.due("Mission paused", "mission_control");
				hooks.onChanged?.(ctx);
				return;
			}
			if (command === "update" || command.startsWith("update ")) {
				try {
					const params = parseUpdateArgs(trimmed.slice("update".length).trim());
					const mission = await updateMission(pi, state, ctx, params, hooks);
					ctx.ui.notify(`Mission updated: ${mission.title}\nObjective version: ${mission.objectiveVersion}\n${formatMission(mission, state.readUsage())}`, "info");
					hooks.onChanged?.(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (command === "complete" || command === "end" || command === "stop") {
				try {
					const result = await completeMission(pi, state, ctx, command === "complete" ? { authorizeCompletion: true } : { userRequested: true }, `/mission ${command}`, hooks, true);
					if (result.alreadyComplete) ctx.ui.notify(`Mission already complete: ${result.mission!.title}`, "info");
					else if (result.blockers?.length) ctx.ui.notify(`Mission completion blocked:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}`, "error");
					else ctx.ui.notify(`${formatMission(result.mission, result.usage)}\nResume: /mission resume`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			try {
				if (!state.readAny()) {
					const takeoverCandidates = listSnapshotTakeoverCandidates(ctx);
					if (takeoverCandidates.length) throw new Error(`A Mission already exists in another session: ${takeoverCandidates.map((candidate) => candidate.snapshot.mission.missionId).join(", ")}. Use /mission takeover instead.`);
				}
				const input = parseCreateArgs(trimmed);
				const event = await state.create(input, ctx);
				const mission = state.append(pi, event)!;
				try { hooks.onCreated?.(ctx); } catch (error) { ctx.ui.notify(`Mission created, but runtime activation reported: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
				try { await initializeMissionArtifacts(mission, state.readUsage()); } catch (error) { ctx.ui.notify(`Mission created, but generated artifacts could not be initialized: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
				ctx.ui.notify(`Mission created: ${mission.title}\nChain: ${mission.chain}@${mission.chainBranch}\nArtifacts: .missions/${mission.slug}`, "info");
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

async function showMissionDashboard(
	pi: ExtensionAPI,
	state: MissionState,
	ctx: ExtensionContext,
	setContext: (ctx: ExtensionContext) => void,
	maybeContinue: (ctx: ExtensionContext) => void,
	hooks: { onChanged?: (ctx: ExtensionContext) => void },
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const render = () => tui.requestRender();
		return new MissionDashboard(state, theme, () => done(undefined), render, () => Math.max(4, tui.terminal.rows - 2), () => {
			const mission = state.readAny();
			if (!mission) return;
			const status: MissionStatus = mission.status === "active" ? "paused" : "active";
			void (async () => {
				if (status === "active" && !await ctx.ui.confirm("Resume Mission?", `Resume autonomous work on ${mission.title}?`)) return;
				if (status === "active") {
					const resumed = await resumeMission(pi, state, "/resume");
					ctx.ui.notify(formatMission(resumed, state.readUsage()), "info");
				} else await setStatus(pi, state, status, ctx, "/pause");
				setContext(ctx);
				if (status === "paused") chainCheckpoints.current?.due("Mission paused", "mission_control");
				hooks.onChanged?.(ctx);
				if (status === "active") maybeContinue(ctx);
				render();
			})().catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
		});
	}, { overlay: true, overlayOptions: FULL_SCREEN_OVERLAY });
}

export function parseCreateArgs(input: string): MissionCreateInput {
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
		else if (token === "--path") (result.paths ??= []).push(parsePath(tokens[++i], true));
		else if (token.startsWith("--path=")) (result.paths ??= []).push(parsePath(token.slice("--path=".length), false));
		else if (token === "--chain") result.chain = unquote(tokens[++i] ?? "");
		else if (token.startsWith("--chain=")) result.chain = token.slice("--chain=".length);
		else if (token === "--branch" || token === "--chain-branch") result.chainBranch = unquote(tokens[++i] ?? "");
		else objectiveParts.push(token);
	}
	result.objective = objectiveParts.join(" ").trim();
	return result;
}

export function parseUpdateArgs(input: string): MissionUpdateInput {
	const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const result: MissionUpdateInput = { reason: "" };
	const reasonParts: string[] = [];
	const limit = (raw: string | undefined, parse: (value: string) => number): number | null => {
		const value = raw ? unquote(raw).trim() : "";
		if (!value) throw new Error("budget/limit flags require a value or 'none'");
		return value.toLowerCase() === "none" ? null : parse(value);
	};
	for (let i = 0; i < tokens.length; i += 1) {
		const token = unquote(tokens[i]!);
		if (token === "--budget" || token === "--tokens" || token === "--token-budget") result.tokenBudget = limit(tokens[++i], (v) => parseBudget(v, token));
		else if (token.startsWith("--budget=")) result.tokenBudget = limit(token.slice("--budget=".length), (v) => parseBudget(v, "--budget"));
		else if (token === "--cost") result.costBudgetUsd = limit(tokens[++i], parseCost);
		else if (token.startsWith("--cost=")) result.costBudgetUsd = limit(token.slice("--cost=".length), parseCost);
		else if (token === "--turns" || token === "--turn-budget") result.turnBudget = limit(tokens[++i], (v) => parsePositiveInt(v, token));
		else if (token.startsWith("--turns=")) result.turnBudget = limit(token.slice("--turns=".length), (v) => parsePositiveInt(v, "--turns"));
		else if (token === "--deadline" || token === "--wall") result.wallDeadlineMs = limit(tokens[++i], (v) => parsePositiveInt(v, token));
		else if (token.startsWith("--deadline=")) result.wallDeadlineMs = limit(token.slice("--deadline=".length), (v) => parsePositiveInt(v, "--deadline"));
		else if (token === "--objective") result.objective = unquote(tokens[++i] ?? "");
		else if (token.startsWith("--objective=")) result.objective = token.slice("--objective=".length);
		else if (token === "--requirement" || token === "--req") (result.requirements ??= []).push(unquote(tokens[++i] ?? ""));
		else if (token.startsWith("--req=")) (result.requirements ??= []).push(token.slice("--req=".length));
		else if (token === "--path") (result.paths ??= []).push(parsePath(tokens[++i], true));
		else if (token.startsWith("--path=")) (result.paths ??= []).push(parsePath(token.slice("--path=".length), false));
		else if (token === "--reason") reasonParts.push(unquote(tokens[++i] ?? ""));
		else if (token.startsWith("--reason=")) reasonParts.push(token.slice("--reason=".length));
		else reasonParts.push(token);
	}
	result.reason = reasonParts.join(" ").trim() || "/mission update";
	if (result.objective === undefined && result.requirements === undefined && result.paths === undefined && result.tokenBudget === undefined && result.costBudgetUsd === undefined && result.turnBudget === undefined && result.wallDeadlineMs === undefined) {
		throw new Error("Nothing to update. Provide at least one of --objective, --req, --path, --budget, --cost, --turns, --deadline (use 'none' to remove a limit).");
	}
	return result;
}

function parsePositiveInt(raw: string, flag: string): number {
	const value = Number(unquote(raw).replace(/,/g, ""));
	if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} requires a positive integer`);
	return value;
}

function parsePath(raw: string | undefined, rejectOption: boolean): string {
	const value = raw ? unquote(raw).trim() : "";
	if (!value || (rejectOption && value.startsWith("--"))) throw new Error("--path requires a value");
	return value;
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
