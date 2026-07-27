import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initializeMissionArtifacts, updateMissionSummaryArtifact } from "./artifacts.ts";
import type { MissionState } from "./state.ts";
import { completeMission, formatMission, resumeMission } from "./tools.ts";
import type { MissionCompleteInput, MissionCreateInput, MissionCurrent, MissionStatus } from "./types.ts";
import { showTextViewer } from "../shared/text-viewer.ts";
import { chainCheckpoints } from "../chains/checkpoint.ts";
import { FULL_SCREEN_OVERLAY } from "../shared/dashboard.ts";
import { MissionDashboard } from "./ui.ts";

export function registerMissionCommands(pi: ExtensionAPI, state: MissionState, setContext: (ctx: ExtensionContext) => void, maybeContinue: (ctx: ExtensionContext) => void, hooks: { validateCompletion?: (input: MissionCompleteInput, ctx: ExtensionContext, directUserRequest?: boolean) => Promise<string[]> | string[]; onCreated?: (ctx: ExtensionContext) => void; onChanged?: (ctx: ExtensionContext) => void; onCompleted?: (ctx: ExtensionContext, mission: MissionCurrent) => Promise<void> | void } = {}): void {
	pi.registerCommand("mission", {
		description: "Create/manage a branch-scoped Mission.",
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
			if (["pause", "resume", "clear"].includes(command)) {
				if (command === "resume") {
					try {
						const mission = await resumeMission(pi, state, "/resume");
						ctx.ui.notify(formatMission(mission, state.readUsage()), "info");
						hooks.onChanged?.(ctx);
						maybeContinue(ctx);
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
			if (command === "complete" || command === "end" || command === "stop") {
				try {
					const result = await completeMission(pi, state, ctx, { userRequested: true }, `/mission ${command}`, hooks, true);
					if (result.alreadyComplete) ctx.ui.notify(`Mission already complete: ${result.mission!.title}`, "info");
					else if (result.blockers?.length) ctx.ui.notify(`Mission completion blocked:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}`, "error");
					else ctx.ui.notify(`${formatMission(result.mission, result.usage)}\nResume: /mission resume`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			try {
				const input = parseCreateArgs(trimmed);
				const event = await state.create(input, ctx);
				const mission = state.append(pi, event)!;
				await initializeMissionArtifacts(mission, state.readUsage());
				hooks.onCreated?.(ctx);
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
