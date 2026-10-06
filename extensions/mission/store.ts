import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const STATUSES = ["active", "paused", "waiting_user", "done", "abandoned"] as const;

const Owner = Type.Object({ pid: Type.Integer(), identity: Type.Optional(Type.String()) });
export type Owner = Static<typeof Owner>;

const State = Type.Object({
	status: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("waiting_user"), Type.Literal("done"), Type.Literal("abandoned")]),
	next: Type.String(),
	owner: Type.Optional(Owner),
	quietContinues: Type.Integer({ minimum: 0 }),
	/** HEAD at the last mission_update or continue; a different HEAD is a new commit. */
	head: Type.Optional(Type.String()),
	review: Type.Optional(Type.Boolean()),
	/** Closing-review rounds started, and whether the last one still waits for its verdict. */
	reviews: Type.Optional(Type.Integer({ minimum: 0 })),
	reviewing: Type.Optional(Type.Boolean()),
});
type MissionState = Static<typeof State>;
export type MissionStatus = MissionState["status"];

export interface Mission {
	slug: string;
	dir: string;
	state: MissionState;
	/** No state.json of this shape: written by the old Missions, loaded as paused. */
	legacy: boolean;
}

const LOG_ENTRIES = 3;
const missionsDir = (cwd: string): string => join(cwd, ".missions");
const cap = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}\n… (cut; the full text is in the file)` : text;

function readState(file: string): MissionState | undefined {
	try {
		const value = JSON.parse(readFileSync(file, "utf8"));
		return Value.Check(State, value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function readText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

function loadMission(cwd: string, slug: string): Mission {
	const dir = join(missionsDir(cwd), slug);
	const state = readState(join(dir, "state.json"));
	return state ? { slug, dir, state, legacy: false } : { slug, dir, state: { status: "paused", next: "", quietContinues: 0 }, legacy: true };
}

/** The project's mission: the folder under `.missions/` whose state was saved last. */
export function currentMission(cwd: string): Mission | undefined {
	let slugs: string[];
	try {
		slugs = readdirSync(missionsDir(cwd), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
	} catch {
		return undefined;
	}
	const saved = (slug: string): number => {
		const dir = join(missionsDir(cwd), slug);
		return statSync(existsSync(join(dir, "state.json")) ? join(dir, "state.json") : dir).mtimeMs;
	};
	const latest = slugs.map((slug) => ({ slug, at: saved(slug) })).sort((a, b) => b.at - a.at)[0];
	return latest && loadMission(cwd, latest.slug);
}

export function createMission(cwd: string, title: string, goal: string, done: string, state: MissionState): Mission {
	const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
	const slug = `${words || "mission"}-${randomBytes(3).toString("hex")}`;
	const mission: Mission = { slug, dir: join(missionsDir(cwd), slug), state, legacy: false };
	mkdirSync(mission.dir, { recursive: true });
	writeFileSync(join(mission.dir, "mission.md"), `# ${title}\n\n## Goal\n\n${goal.trim()}\n\n## Done when\n\n${done.trim()}\n`);
	writeFileSync(join(mission.dir, "log.md"), `# Mission log: ${title}\n`);
	saveMission(mission, "Started.");
	return mission;
}

/** Writes state.json, after appending `log` to log.md under the time and the status. */
export function saveMission(mission: Mission, log?: string): void {
	if (log !== undefined) appendFileSync(join(mission.dir, "log.md"), `\n## ${new Date().toISOString()} ${mission.state.status}\n\n${log.trim()}\n`);
	// A torn state.json would load the mission as legacy and pause it.
	const tmp = join(mission.dir, `state.json.${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(mission.state, null, 2)}\n`);
	renameSync(tmp, join(mission.dir, "state.json"));
	mission.legacy = false;
}

export const reviewPath = (mission: Mission): string => `.missions/${mission.slug}/review.js`;

/** Goal, done criteria, the last log entries and the next step, as the lead sees them. */
export function missionBrief(mission: Mission): string {
	const entries = readText(join(mission.dir, "log.md")).split(/^(?=## )/m).filter((entry) => entry.startsWith("## ")).slice(-LOG_ENTRIES);
	return [
		`Mission ${mission.slug} is ${mission.state.status}. Its files are in .missions/${mission.slug}/ (mission.md, log.md, state.json).`,
		...(mission.legacy ? ["An older version of the kit saved it, so it loaded as paused. Resume it (status active) or end it (abandoned) only when the user asks."] : []),
		cap(readText(join(mission.dir, "mission.md")).trim(), 4_000),
		`Latest log entries:\n\n${entries.map((entry) => cap(entry.trim(), 1_500)).join("\n\n") || "(none)"}`,
		`Next step: ${mission.state.next || "(not recorded yet)"}`,
		...(mission.state.reviewing ? [`Closing review round ${mission.state.reviews} waits for its verdict: run Workflow({scriptPath: "${reviewPath(mission)}"}) if it has not reported, then pass its verdict to mission_update.`] : []),
	].join("\n\n");
}
