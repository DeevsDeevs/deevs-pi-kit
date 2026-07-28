import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMissionCommands } from "./commands.ts";
import { MissionState } from "./state.ts";
import { registerMissionTools } from "./tools.ts";
import { MissionRuntime } from "./runtime.ts";

const SURFACE_KEY = Symbol.for("deevs-pi-kit.mission-surface");

interface MissionSurfaceState { active: boolean }
interface GlobalWithMissionSurface { [SURFACE_KEY]?: MissionSurfaceState }

export default function missionExtension(pi: ExtensionAPI): void {
	const globalState = globalThis as GlobalWithMissionSurface;
	if (globalState[SURFACE_KEY]?.active) return;
	const surfaceState: MissionSurfaceState = { active: true };
	globalState[SURFACE_KEY] = surfaceState;

	const state = new MissionState();
	const runtime = new MissionRuntime(pi, state);
	registerMissionTools(pi, state, (ctx) => runtime.restore(ctx), {
		validateCompletion: (input, ctx) => runtime.validateCompletion(input, ctx),
		onCreated: (ctx) => runtime.onCreated(ctx),
		onTakenOver: (ctx, mission) => runtime.onTakenOver(ctx, mission),
		onProgress: (input, ctx) => runtime.onProgress(input, ctx),
		workspaceFingerprint: (ctx) => runtime.workspaceFingerprint(ctx),
		onObjectiveUpdated: (input, ctx) => runtime.onObjectiveUpdated(input, ctx),
		onResumed: (ctx) => { runtime.restore(ctx); void runtime.maybeContinue(ctx); },
		onCompleted: (ctx, mission) => runtime.onCompleted(ctx, mission),
	});
	registerMissionCommands(pi, state, (ctx) => runtime.restore(ctx), (ctx) => void runtime.maybeContinue(ctx), {
		validateCompletion: (input, ctx, directUserRequest) => runtime.validateCompletion(input, ctx, directUserRequest),
		onCreated: (ctx) => runtime.onCreated(ctx),
		onTakenOver: (ctx, mission) => runtime.onTakenOver(ctx, mission),
		onChanged: (ctx) => runtime.restore(ctx),
		onObjectiveUpdated: (input, ctx) => runtime.onObjectiveUpdated(input, ctx),
		onCompleted: (ctx, mission) => runtime.onCompleted(ctx, mission),
	});
	runtime.register();

	pi.on("session_shutdown", () => {
		surfaceState.active = false;
	});
}
