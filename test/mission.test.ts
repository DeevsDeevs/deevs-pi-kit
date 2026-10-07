import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import missionExtension from "../extensions/mission/index.ts";
import { currentMission } from "../extensions/mission/store.ts";
import { readProcessIdentity } from "../extensions/shared/process-group.ts";
import { tasks } from "../extensions/shared/tasks.ts";

type Tool = { execute: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<{ details: Record<string, unknown> }> };
type Handler = (event: { systemPromptOptions: { sections: Record<string, string> } }, ctx: { cwd: string }) => void;

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "mission-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function lead() {
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, Handler>();
	missionExtension({
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
		getActiveTools: () => [...tools.keys()],
	} as unknown as ExtensionAPI);
	const call = (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("call", params, undefined, undefined, { cwd });
	const section = () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		handlers.get("before_agent_start")!(event, { cwd });
		return event.systemPromptOptions.sections.mission;
	};
	return { call, section };
}

it("continues only when active, autonomous, idle, owned and nothing runs; three quiet continues pause it", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	const sent: string[] = [];
	const handlers = new Map<string, (event: object, ctx: object) => void>();
	const tools = new Map<string, Tool>();
	missionExtension({
		on: (name: string, handler: (event: object, ctx: object) => void) => handlers.set(name, handler),
		registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
		sendMessage: (message: { customType: string }) => sent.push(message.customType),
		getActiveTools: () => [...tools.keys()],
	} as unknown as ExtensionAPI);
	let idle = true;
	const ctx = { cwd, isProjectTrusted: () => true, isIdle: () => idle, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "s" } };
	const settle = async () => {
		handlers.get("agent_settled")!({}, ctx);
		await new Promise((resolve) => setTimeout(resolve, 300));
		return sent.splice(0);
	};
	try {
		expect(await settle()).toEqual([]);
		await tools.get("mission_start")!.execute("call", { title: "t", goal: "g", done: "d" }, undefined, undefined, ctx);
		idle = false;
		expect(await settle()).toEqual([]);
		idle = true;
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ autonomy: "ask" }));
		expect(await settle()).toEqual([]);
		rmSync(join(cwd, ".pi"), { recursive: true });
		tasks.register({ id: "a1", kind: "agent", description: "busy", status: "running", ownerSession: "s", startedAt: 0 });
		expect(await settle()).toEqual([]);
		tasks.register({ id: "a1", kind: "monitor", description: "watch", status: "running", ownerSession: "s", startedAt: 0 });
		tasks.register({ id: "c1", kind: "collaborator", description: "idle tab", status: "running", ownerSession: "s", startedAt: 0 });
		tasks.register({ id: "o1", kind: "agent", description: "another session's", status: "running", ownerSession: "other", startedAt: 0 });
		expect(await settle()).toEqual(["mission-continue"]);
		for (const id of ["a1", "c1", "o1"]) tasks.remove(id);
		expect([await settle(), await settle(), await settle(), await settle()]).toEqual([["mission-continue"], ["mission-continue"], ["mission-notice"], []]);
		expect(currentMission(cwd)?.state).toMatchObject({ status: "paused", quietContinues: 3 });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

it("at startup reads the roster only once the engine has resumed the session's agents", async () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
	tasks.install({ on: () => {} } as unknown as ExtensionAPI);
	const sent: string[] = [];
	const handlers = new Map<string, (event: object, ctx: object) => void>();
	const tools = new Map<string, Tool>();
	missionExtension({
		on: (name: string, handler: (event: object, ctx: object) => void) => handlers.set(name, handler),
		registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
		sendMessage: (message: { customType: string }) => sent.push(message.customType),
		getActiveTools: () => [...tools.keys()],
	} as unknown as ExtensionAPI);
	const ctx = { cwd, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "boot" } };
	const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
	try {
		await tools.get("mission_start")!.execute("call", { title: "t", goal: "g", done: "d" }, undefined, undefined, ctx);
		handlers.get("session_start")!({ reason: "startup" }, ctx);
		await pause();
		tasks.register({ id: "a9", kind: "agent", description: "resumed", status: "running", ownerSession: "boot", startedAt: 0 });
		tasks.markResumed("boot");
		await pause();
		expect(sent).toEqual([]);
		tasks.remove("a9");
		handlers.get("session_start")!({ reason: "resume" }, ctx);
		await pause();
		expect(sent).toEqual(["mission-continue"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

it("leaves a mission whose owner is another live Pi to that Pi", async () => {
	const sent: string[] = [];
	const handlers = new Map<string, (event: object, ctx: object) => void>();
	missionExtension({
		on: (name: string, handler: (event: object, ctx: object) => void) => handlers.set(name, handler),
		registerTool: () => {},
		getActiveTools: () => ["mission_update"],
		sendMessage: (message: { customType: string }) => sent.push(message.customType),
	} as unknown as ExtensionAPI);
	mkdirSync(join(cwd, ".missions", "m"), { recursive: true });
	const owner = { pid: process.ppid, identity: await readProcessIdentity(process.ppid) };
	writeFileSync(join(cwd, ".missions", "m", "state.json"), JSON.stringify({ status: "active", next: "", quietContinues: 0, owner }));
	handlers.get("agent_settled")!({}, { cwd, isProjectTrusted: () => true, isIdle: () => true, hasPendingMessages: () => false });
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(sent).toEqual([]);
	expect(currentMission(cwd)?.state.owner).toEqual(owner);
});

it("loads the old layout, and a state.json of any other shape, as paused", () => {
	mkdirSync(join(cwd, ".missions", ".state"), { recursive: true });
	mkdirSync(join(cwd, ".missions", "old"));
	writeFileSync(join(cwd, ".missions", ".state", "old.json"), JSON.stringify({ version: 1, mission: { status: "active" } }));
	expect(currentMission(cwd)).toMatchObject({ slug: "old", legacy: true, state: { status: "paused", quietContinues: 0 } });
	writeFileSync(join(cwd, ".missions", "old", "state.json"), JSON.stringify({ version: 1, mission: { status: "active" } }));
	expect(currentMission(cwd)).toMatchObject({ slug: "old", legacy: true, state: { status: "paused" } });
});

it("carries goal, done criteria, the last three log entries and the next step while open", async () => {
	const { call, section } = lead();
	await expect(call("mission_update", { log: "x", next: "y" })).rejects.toThrow("No mission in this project");
	const { details } = await call("mission_start", { title: "Ship it", goal: "Ship the release.", done: "The tag is pushed." });
	expect(details).toMatchObject({ status: "active" });
	await expect(call("mission_start", { title: "Another", goal: "g", done: "d" })).rejects.toThrow(`Mission ${details.slug} is active`);
	for (const n of [1, 2, 3]) await call("mission_update", { log: `entry ${n}`, next: `step ${n}` });
	expect(section()).toContain("Ship the release.");
	expect(section()).toContain("The tag is pushed.");
	expect(section()).toContain("Next step: step 3");
	expect(["entry 1", "entry 2", "entry 3", "Started."].map((entry) => section().includes(entry))).toEqual([true, true, true, false]);
	await call("mission_update", { log: "asked", next: "wait", status: "waiting_user" });
	expect(section()).toContain("is waiting_user");
	await call("mission_update", { log: "user said stop", next: "none", status: "paused" });
	expect(section()).toBeUndefined();
	expect(currentMission(cwd)?.state).toMatchObject({ status: "paused", quietContinues: 0, owner: { pid: process.pid } });
});

it("runs at most two closing-review rounds before a review mission closes", async () => {
	const { call } = lead();
	await call("mission_start", { title: "Reviewed", goal: "g", done: "d", review: true });
	await expect(call("mission_update", { log: "x", next: "y", verdict: "clear" })).rejects.toThrow("No closing review waits");
	expect((await call("mission_update", { log: "built", next: "review", status: "done" })).details.status).toBe("active");
	expect(readFileSync(join(cwd, ".missions", currentMission(cwd)!.slug, "review.js"), "utf8")).toContain('"enum":["changes_requested","clear"]');
	expect(readFileSync(join(cwd, ".missions", currentMission(cwd)!.slug, "review.js"), "utf8")).toContain('agentType: "reviewer"');
	await expect(call("mission_update", { log: "x", next: "y", status: "done" })).rejects.toThrow("waits for its verdict");
	expect((await call("mission_update", { log: "missing tests", next: "add tests", verdict: "changes_requested" })).details.status).toBe("active");
	expect((await call("mission_update", { log: "tests added", next: "review", status: "done" })).details.status).toBe("active");
	expect((await call("mission_update", { log: "still missing", next: "none", verdict: "changes_requested" })).details.status).toBe("done");
	expect(currentMission(cwd)?.state).toMatchObject({ status: "done", reviews: 2, reviewing: false });
});
