import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MissionState } from "./state.ts";

const STATUS_ID = "mission";

export function updateMissionStatus(ctx: ExtensionContext, state: MissionState): void {
	const mission = state.read();
	if (!mission) {
		ctx.ui.setStatus(STATUS_ID, undefined);
		return;
	}
	const usage = state.readUsage();
	const budget = mission.tokenBudget ? `${compact(usage.totalTokens)}/${compact(mission.tokenBudget)}` : compact(usage.totalTokens);
	ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `mission: ${mission.status} · ${budget} · ${compactText(mission.title, 28)}`));
}

export function clearMissionStatus(ctx?: ExtensionContext): void {
	ctx?.ui?.setStatus(STATUS_ID, undefined);
}

function compactText(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function compact(value: number): string {
	if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(Math.round(value));
}
