import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAutonomous } from "../shared/config.ts";
import { ownsProcessIdentity, readProcessIdentity } from "../shared/process-group.ts";
import { systemReminder, tasks } from "../shared/tasks.ts";
import { git } from "../shared/worktree.ts";
import { createMission, currentMission, missionBrief, reviewPath, saveMission, STATUSES, type Mission, type MissionStatus, type Owner } from "./store.ts";

const STALL_CONTINUES = 3;
const REVIEW_ROUNDS = 2;
const MISSION_CONTINUE = "mission-continue";
const MISSION_NOTICE = "mission-notice";

const OPEN: readonly MissionStatus[] = ["active", "waiting_user"];

const GUIDANCE = [
	"Work toward the done criteria without waiting for the user. After each meaningful step, call mission_update with what happened and the next step.",
	"Set status \"waiting_user\" when only the user can unblock you, \"done\" when the done criteria hold, and \"paused\" or \"abandoned\" only when the user asks.",
].join("\n");

let self: Promise<Owner> | undefined;
const thisProcess = (): Promise<Owner> => self ??= readProcessIdentity(process.pid).then((identity) => ({ pid: process.pid, identity }));

const gitHead = (cwd: string): Promise<string | undefined> => git(cwd, ["rev-parse", "HEAD"]).then((out) => out.trim() || undefined, () => undefined);

const text = (value: string, details: Record<string, string | boolean>) => ({ content: [{ type: "text" as const, text: value }], details });

export default function missionExtension(pi: ExtensionAPI): void {
	let interrupted = false;
	// Deferred past agent_settled so a notification turn queued in the same settle runs first and the idle check sees it.
	const later = (ctx: ExtensionContext): void => {
		setTimeout(() => void maybeContinue(pi, ctx).catch(() => {
			// A stale ctx after /reload or a session switch; the next settle checks again.
		}), 0);
	};

	pi.on("session_start", (event, ctx) => {
		interrupted = false;
		// The agents the engine resumes are running work: check only once they are on the roster.
		if (event.reason === "startup" || event.reason === "resume") void tasks.resumed(ctx.sessionManager.getSessionId()).then(() => later(ctx));
	});
	pi.on("agent_end", (event) => {
		const last = event.messages.filter((message) => message.role === "assistant").pop();
		interrupted = last?.stopReason === "aborted" || last?.stopReason === "error";
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (!interrupted) later(ctx);
	});
	const section = (ctx: ExtensionContext): string | undefined => {
		// A Pi collaborator in the lead's directory has no mission tools.
		if (!pi.getActiveTools().includes("mission_update")) return undefined;
		const mission = currentMission(ctx.cwd);
		return mission && OPEN.includes(mission.state.status) ? `${missionBrief(mission)}\n\n${GUIDANCE}` : undefined;
	};
	tasks.addSection("mission", section);
	pi.on("before_agent_start", (event, ctx) => {
		const mission = section(ctx);
		if (mission) event.systemPromptOptions.sections.mission = mission;
	});

	pi.registerTool({
		name: "mission_start",
		label: "Mission start",
		description: [
			"Start a Mission: a long goal you pursue across turns and sessions until its done criteria hold. Files live in .missions/<slug>/.",
			"While it is active you are prompted to continue each time you finish with nothing running, so start one only when the user asks for a mission or for long work to carry on unattended.",
		].join("\n"),
		promptSnippet: "Start a Mission that keeps going on its own until its done criteria hold.",
		parameters: Type.Object({
			title: Type.String({ description: "A short title" }),
			goal: Type.String({ description: "What the mission must achieve, with its constraints" }),
			done: Type.String({ description: "The done criteria, concrete enough for you to check" }),
			review: Type.Optional(Type.Boolean({ description: `Run a closing-review Workflow, at most ${REVIEW_ROUNDS} rounds, before the mission closes` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const open = currentMission(ctx.cwd);
			if (open && OPEN.includes(open.state.status)) throw new Error(`Mission ${open.slug} is ${open.state.status}. Close it (done or abandoned) or pause it with mission_update before starting another.`);
			const mission = createMission(ctx.cwd, params.title, params.goal, params.done, {
				status: "active", next: "", quietContinues: 0, owner: await thisProcess(), head: await gitHead(ctx.cwd), review: params.review,
			});
			return text(`Mission started: .missions/${mission.slug}/. It continues each time you finish with nothing running. Record progress with mission_update.`, { slug: mission.slug, status: "active" });
		},
	});

	pi.registerTool({
		name: "mission_update",
		label: "Mission update",
		description: "Log progress on the project's Mission and set its next step. Set status to change its state: active resumes it, paused or abandoned when the user asks, waiting_user when only the user can unblock you, done when its done criteria hold (a review mission first runs its closing review).",
		promptSnippet: "Log Mission progress and its next step, or change its status.",
		parameters: Type.Object({
			log: Type.String({ description: "What happened since the last update: progress, evidence, decisions" }),
			next: Type.String({ description: "The next concrete step" }),
			status: Type.Optional(StringEnum(STATUSES, { description: "Omit to keep the current status" })),
			verdict: Type.Optional(StringEnum(["clear", "changes_requested"], { description: "The closing review's verdict once its Workflow reports; put its findings in log" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const mission = currentMission(ctx.cwd);
			if (!mission) throw new Error("No mission in this project. Start one with mission_start.");
			const { state } = mission;
			const rounds = state.reviews ?? 0;
			let status = params.status ?? state.status;
			let review = "";
			if (params.verdict) {
				if (!state.reviewing) throw new Error("No closing review waits for a verdict.");
				state.reviewing = false;
				// A changes_requested verdict reopens only an active mission: one the user paused meanwhile stays paused.
				status = params.verdict === "clear" || rounds >= REVIEW_ROUNDS ? "done" : state.status;
			} else if (status === "done" && state.review) {
				if (state.reviewing) throw new Error(`Closing review round ${rounds} waits for its verdict: pass it as verdict.`);
				if (rounds < REVIEW_ROUNDS) {
					status = "active";
					state.reviews = rounds + 1;
					state.reviewing = true;
					writeReviewScript(mission);
					review = ` Closing review round ${rounds + 1} of ${REVIEW_ROUNDS}: run Workflow({scriptPath: "${reviewPath(mission)}"}); when it reports, call mission_update with its verdict and its findings as log.`;
				}
			}
			mission.state = { ...state, status, next: params.next, quietContinues: 0, owner: await thisProcess(), head: await gitHead(ctx.cwd) };
			saveMission(mission, params.log);
			return text(`Mission ${mission.slug} is ${status}.${review}`, { slug: mission.slug, status });
		},
	});

	pi.registerTool({
		name: "mission_get",
		label: "Mission get",
		description: "Show the project's Mission: its status, goal, done criteria, latest log entries and next step.",
		promptSnippet: "Show the project's Mission and where it stands.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const mission = currentMission(ctx.cwd);
			if (!mission) return text("No mission in this project.", {});
			return text(missionBrief(mission), { slug: mission.slug, status: mission.state.status, legacy: mission.legacy });
		},
	});
}

/** The autonomous continue: enum, counter and pid checks only. */
async function maybeContinue(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!pi.getActiveTools().includes("mission_update")) return;
	const mission = currentMission(ctx.cwd);
	if (mission?.state.status !== "active") return;
	const { state } = mission;
	const me = await thisProcess();
	if (state.owner?.pid !== me.pid || state.owner.identity !== me.identity) {
		if (state.owner && await ownsProcessIdentity(state.owner.pid, state.owner.identity)) return;
		state.owner = me;
	}
	if (!isAutonomous(ctx)) return;
	// Monitors and collaborators wake the lead themselves, by notification or by mail.
	if (tasks.list(ctx.sessionManager.getSessionId()).some((task) => task.status === "running" && task.kind !== "monitor" && task.kind !== "collaborator")) return;
	const head = await gitHead(ctx.cwd);
	if (head !== state.head) {
		state.head = head;
		state.quietContinues = 0;
	}
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
	if (state.quietContinues >= STALL_CONTINUES) return pause(pi, mission);
	state.quietContinues++;
	saveMission(mission);
	pi.sendMessage({
		customType: MISSION_CONTINUE,
		content: systemReminder(`Mission continue: nothing else is running, so carry on with the mission below.\n\n${missionBrief(mission)}\n\n${GUIDANCE}`),
		display: false,
		details: { slug: mission.slug, quietContinues: state.quietContinues },
	}, { triggerTurn: true });
}

function pause(pi: ExtensionAPI, mission: Mission): void {
	mission.state.status = "paused";
	saveMission(mission, `Paused after ${STALL_CONTINUES} continues with no mission_update and no new commit.`);
	pi.sendMessage({
		customType: MISSION_NOTICE,
		content: `Mission ${mission.slug} paused: ${STALL_CONTINUES} continues passed with no mission_update and no new commit. Ask the lead to resume it when you want it to go on.`,
		display: true,
		details: { slug: mission.slug, status: "paused" },
	});
}

const VERDICT_SCHEMA = {
	type: "object",
	properties: { verdict: { type: "string", enum: ["changes_requested", "clear"] }, findings: { type: "string" } },
	required: ["verdict", "findings"],
};

/** One read-only reviewer that checks the done criteria in mission.md and answers through the verdict schema. */
function writeReviewScript(mission: Mission): void {
	const prompt = [
		"READ-ONLY. Closing review of a Mission: check, in the repository as it is now, that every done criterion below holds.",
		"Answer verdict \"clear\" only when all of them hold; otherwise \"changes_requested\", with findings naming what is missing or wrong, with file paths.",
		"",
		readFileSync(join(mission.dir, "mission.md"), "utf8"),
	].join("\n");
	writeFileSync(join(mission.dir, "review.js"), [
		`export const meta = { name: "mission-review", description: ${JSON.stringify(`Closing review of mission ${mission.slug}`)} };`,
		`return await agent(${JSON.stringify(prompt)}, { label: "closing review", agentType: "reviewer", schema: ${JSON.stringify(VERDICT_SCHEMA)} });`,
		"",
	].join("\n"));
}
