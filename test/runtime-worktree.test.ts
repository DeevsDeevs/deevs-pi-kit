import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedParticipantCoordinator } from "../extensions/runtime/service/participant.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore } from "../extensions/runtime/service/state.ts";
import { RuntimeWorktrees } from "../extensions/runtime/service/worktree.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
}

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	async getAgent(agentName: string): Promise<HostedLiveAgent> { const value = this.agents.get(agentName); if (!value) throw new Error("missing agent"); return value; }
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
	const runtimeRoot = join(root, "runtime");
	const store = new HostedStateStore(runtimeRoot);
	let registrationId = 0;
	const registrations = new RuntimeRegistrationManager(store, host, { createId: () => `reg_${++registrationId}`, createKey: () => `key_${registrationId}` });
	const participants = new HostedParticipantCoordinator(store, registrations, { createGeneration: () => `lease_${Object.keys(store.read().participants).length + 1}` });
	const input: RegisterPiInput = { projectRoot: project, piSessionId: "session_main", piSessionFile: sessionFile };
	return { root, project, host, store, registrations, participants, input, worktrees: new RuntimeWorktrees(runtimeRoot, store) };
}

describe("Runtime collaborator worktrees", () => {
	it("provisions one branch per writer, records it on the participant, and removes it on cleanup", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		const authority = { callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol: "review", participantId: "writer" };

		const worktree = await test.worktrees.ensure(main, authority);
		expect(worktree).toMatchObject({ protocol: "review", participantId: "writer", branchRef: "refs/heads/runtime/collab/review/writer" });
		expect(existsSync(join(worktree.path, "app.txt"))).toBe(true);
		expect(git(worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("runtime/collab/review/writer");
		expect(await test.worktrees.ensure(main, authority)).toEqual(worktree);

		const writerSession = join(test.root, "writer.jsonl");
		writeFileSync(writerSession, `${JSON.stringify({ type: "session", version: 3, id: "session_writer", timestamp: "2026-01-01T00:00:00.000Z", cwd: worktree.path })}\n`);
		const writer = await test.registrations.register({ projectRoot: test.project, worktreePath: worktree.path, piSessionId: "session_writer", piSessionFile: writerSession });
		expect(test.store.read().targets[writer.targetKey]).toMatchObject({ kind: "pi", projectRoot: test.project, worktreePath: worktree.path });
		const held = test.participants.acquire(writer, "review", "writer").participant;
		expect(test.store.read().participants[held.participantKey]?.worktreePath).toBe(worktree.path);
		expect(await test.worktrees.list(main)).toEqual([{ ...worktree, participantState: "held", recorded: true }]);

		await expect(test.worktrees.remove(main, { ...authority, discardConfirmed: true })).rejects.toThrow("Stop the collaborator");
		test.participants.standDown(writer, held.participantKey);
		await expect(test.worktrees.remove(main, { ...authority, discardConfirmed: false })).rejects.toThrow("confirmed discard");
		expect(await test.worktrees.remove(main, { ...authority, discardConfirmed: true })).toEqual({ removed: true });
		expect(existsSync(worktree.path)).toBe(false);
		expect(git(test.project, ["branch", "--list", "runtime/collab/review/writer"])).toBe("");
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

	it("keeps one participant ID apart across protocols", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		const authority = { callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation };
		const review = await test.worktrees.ensure(main, { ...authority, protocol: "review", participantId: "writer" });
		const build = await test.worktrees.ensure(main, { ...authority, protocol: "build", participantId: "writer" });

		expect(build.path).not.toBe(review.path);
		expect(build.branchRef).toBe("refs/heads/runtime/collab/build/writer");
		const removal = { ...authority, protocol: "build", participantId: "writer", discardConfirmed: true };
		expect(await test.worktrees.remove(main, removal)).toEqual({ removed: true });
		expect(existsSync(build.path)).toBe(false);
		expect(existsSync(review.path)).toBe(true);
		expect(git(test.project, ["branch", "--list", "runtime/collab/review/writer"])).toContain("runtime/collab/review/writer");
	});

	it("reattaches a leftover collaborator branch that has no worktree", async () => {
		const test = setup();
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		git(test.project, ["branch", "runtime/collab/review/writer"]);

		const worktree = await test.worktrees.ensure(main, {
			callerParticipantKey: caller.participantKey,
			expectedCallerGeneration: caller.generation,
			protocol: "review",
			participantId: "writer",
		});
		expect(git(worktree.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("runtime/collab/review/writer");
	});
});
