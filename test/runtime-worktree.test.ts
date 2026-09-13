import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedParticipantCoordinator } from "../extensions/runtime/service/participant.ts";
import { RuntimeRegistrationManager, type HostedHostVerifier, type HostedLiveAgent, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore } from "../extensions/runtime/service/state.ts";
import { RuntimeWorktrees } from "../extensions/runtime/service/worktree.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
}

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	async getAgent(paneId: string): Promise<HostedLiveAgent> { const value = this.agents.get(paneId); if (!value) throw new Error("missing agent"); return value; }
	async findTerminal(terminalId: string): Promise<HostedLiveAgent> { const values = [...this.agents.values()].filter((agent) => agent.terminalId === terminalId); if (values.length !== 1) throw new Error("missing terminal"); return values[0]!; }
}

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-worktree-"));
	roots.push(root);
	const project = join(root, "project");
	mkdirSync(project);
	git(project, ["init", "-b", "main"]);
	writeFileSync(join(project, "app.txt"), "base\n");
	git(project, ["add", "-A"]);
	git(project, ["commit", "-m", "base"]);
	const sessionFile = join(root, "main.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_main", timestamp: "2026-01-01T00:00:00.000Z", cwd: project })}\n`);
	const host = new FakeHost();
	host.agents.set("w1:p1", { paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", terminalId: "term_main", cwd: project, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: sessionFile }, status: "idle", stateChangeSeq: 1 });
	const runtimeRoot = join(root, "runtime");
	const store = new HostedStateStore(runtimeRoot);
	let registrationId = 0;
	const registrations = new RuntimeRegistrationManager(store, host, { createId: () => `reg_${++registrationId}`, createKey: () => `key_${registrationId}` });
	const participants = new HostedParticipantCoordinator(store, registrations, { request() {} }, { createGeneration: () => `lease_${Object.keys(store.read().participants).length + 1}` });
	const input: RegisterPiInput = { projectRoot: project, piSessionId: "session_main", piSessionFile: sessionFile, clientGeneration: "client_main", admittedClaims: [], herdr: { paneId: "w1:p1", terminalId: "term_main" } };
	return { root, project, host, store, registrations, participants, input, worktrees: new RuntimeWorktrees(runtimeRoot, store) };
}

describe("Runtime collaborator worktrees", () => {
	it("provisions one branch per writer, records it on the participant, and removes it on cleanup", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		const authority = { callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol: "review", participantId: "writer" };

		const worktree = await test.worktrees.ensure(main, authority);
		expect(worktree).toMatchObject({ participantId: "writer", branchRef: "refs/heads/runtime/collab/writer" });
		expect(existsSync(join(worktree.path, "app.txt"))).toBe(true);
		expect(git(worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("runtime/collab/writer");
		expect(await test.worktrees.ensure(main, authority)).toEqual(worktree);

		const writerSession = join(test.root, "writer.jsonl");
		writeFileSync(writerSession, `${JSON.stringify({ type: "session", version: 3, id: "session_writer", timestamp: "2026-01-01T00:00:00.000Z", cwd: worktree.path })}\n`);
		test.host.agents.set("w1:p9", { paneId: "w1:p9", tabId: "w1:t9", workspaceId: "w1", terminalId: "term_writer", cwd: worktree.path, agentSession: { source: "herdr:pi", agent: "pi", kind: "path", value: writerSession }, status: "idle", stateChangeSeq: 2 });
		const writer = await test.registrations.register({ projectRoot: test.project, worktreePath: worktree.path, piSessionId: "session_writer", piSessionFile: writerSession, clientGeneration: "client_writer", admittedClaims: [], herdr: { paneId: "w1:p9", terminalId: "term_writer" } });
		expect(test.store.read().targets[writer.targetKey]).toMatchObject({ kind: "pi", projectRoot: test.project, worktreePath: worktree.path });
		const held = test.participants.acquire(writer, "review", "writer").participant;
		expect(test.store.read().participants[held.participantKey]?.worktreePath).toBe(worktree.path);
		expect(await test.worktrees.list(main)).toEqual([{ ...worktree, protocol: "review", participantState: "held", recorded: true }]);

		await expect(test.worktrees.remove(main, { ...authority, discardConfirmed: true })).rejects.toThrow("Stop the collaborator");
		test.participants.standDown(writer, held.participantKey);
		await expect(test.worktrees.remove(main, { ...authority, discardConfirmed: false })).rejects.toThrow("confirmed discard");
		expect(await test.worktrees.remove(main, { ...authority, discardConfirmed: true })).toEqual({ removed: true });
		expect(existsSync(worktree.path)).toBe(false);
		expect(git(test.project, ["branch", "--list", "runtime/collab/writer"])).toBe("");
		expect(test.store.read().participants[held.participantKey]?.worktreePath).toBeUndefined();
		expect(await test.worktrees.list(main)).toEqual([]);
	});

	it("rejects worktree authority from a caller that does not hold its identity", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		await expect(test.worktrees.ensure(main, { callerParticipantKey: caller.participantKey, expectedCallerGeneration: "lease_other", protocol: "review", participantId: "writer" })).rejects.toThrow("caller authority");
		await expect(test.worktrees.ensure(main, { callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol: "review", participantId: "main" })).rejects.toThrow("own worktree");
		expect(await test.worktrees.list(main)).toEqual([]);
	});
});
