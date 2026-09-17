import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostedParticipantCoordinator } from "../extensions/runtime/service/participant.ts";
import type { HostedHostVerifier, HostedLiveAgent } from "../extensions/runtime/service/identity.ts";
import { RuntimeRegistrationManager, type RegisterPiInput } from "../extensions/runtime/service/registration.ts";
import { HostedStateStore } from "../extensions/runtime/service/state.ts";
import { RuntimeWorktrees } from "../extensions/runtime/service/worktree.ts";
import { deriveAgentTargetKey } from "../extensions/runtime/service/state.ts";
import { RuntimeAgentBinder } from "../extensions/runtime/service/bridge.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
}

class FakeHost implements HostedHostVerifier {
	readonly agents = new Map<string, HostedLiveAgent>();
	async getAgent(agentName: string): Promise<HostedLiveAgent> { const value = this.agents.get(agentName); if (!value) throw new Error("missing agent"); return value; }
}

function initRepo(path: string): void {
	mkdirSync(path, { recursive: true });
	git(path, ["init", "-b", "main"]);
	writeFileSync(join(path, "app.txt"), "base\n");
	git(path, ["add", "-A"]);
	git(path, ["commit", "-m", "base"]);
}

function setup(layout: "repo" | "folder" = "repo") {
	const root = mkdtempSync(join(tmpdir(), "pi-kit-runtime-worktree-"));
	roots.push(root);
	const project = join(root, "project");
	if (layout === "repo") initRepo(project);
	else {
		mkdirSync(project);
		initRepo(join(project, "api"));
		initRepo(join(root, "elsewhere"));
		symlinkSync(join(root, "elsewhere"), join(project, "web"));
		mkdirSync(join(project, "notes"));
	}
	const sessionFile = join(root, "main.jsonl");
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "session_main", timestamp: "2026-01-01T00:00:00.000Z", cwd: project })}\n`);
	const host = new FakeHost();
	const runtimeRoot = join(root, "runtime");
	const store = new HostedStateStore(runtimeRoot);
	let registrationId = 0;
	const registrations = new RuntimeRegistrationManager(store, host, { createId: () => `reg_${++registrationId}`, createKey: () => `key_${registrationId}` });
	const participants = new HostedParticipantCoordinator(store, registrations, { createGeneration: () => `lease_${Object.keys(store.read().participants).length + 1}` });
	const input: RegisterPiInput = { projectRoot: project, piSessionId: "session_main", piSessionFile: sessionFile };
	const bridges = new RuntimeAgentBinder(store, registrations, host, { createGeneration: () => "lease_agent" });
	return { root, project, host, store, registrations, participants, bridges, input, worktrees: new RuntimeWorktrees(runtimeRoot, store) };
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

	/** One runtime root serves every project, so the same identity in a second project needs its own directory. */
	it("keeps one participant ID apart across projects sharing a runtime root", async () => {
		const first = setup();
		const second = setup();
		const runtimeRoot = join(first.root, "runtime");
		const shared = new RuntimeWorktrees(runtimeRoot, second.store);
		const main = await first.registrations.register(first.input);
		const caller = first.participants.acquire(main, "review", "main").participant;
		const other = await second.registrations.register(second.input);
		const otherCaller = second.participants.acquire(other, "review", "main").participant;

		const mine = await first.worktrees.ensure(main, { callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol: "review", participantId: "writer" });
		const theirs = await shared.ensure(other, { callerParticipantKey: otherCaller.participantKey, expectedCallerGeneration: otherCaller.generation, protocol: "review", participantId: "writer" });
		expect(theirs.path).not.toBe(mine.path);
		expect(theirs.path.startsWith(join(runtimeRoot, "workspaces"))).toBe(true);
		expect(existsSync(join(mine.path, "app.txt"))).toBe(true);
		expect(git(theirs.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("runtime/collab/review/writer");
		expect(git(theirs.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).not.toBe(git(mine.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
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

	it("provisions a writer's worktree from the named repo inside a folder of repositories", async () => {
		const test = setup("folder");
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		const authority = { callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol: "review" };

		await expect(test.worktrees.ensure(main, { ...authority, participantId: "writer" })).rejects.toThrow("pass repo for writer. Repositories here: api, web.");
		await expect(test.worktrees.ensure(main, { ...authority, participantId: "writer", repo: "../project/api" })).rejects.toThrow("relative path");
		await expect(test.worktrees.ensure(main, { ...authority, participantId: "writer", repo: "notes" })).rejects.toThrow("not the top level");
		await expect(test.worktrees.ensure(main, { ...authority, participantId: "writer", repo: "missing" })).rejects.toThrow("does not exist");

		const api = join(test.project, "api");
		const web = join(test.root, "elsewhere");
		const worktree = await test.worktrees.ensure(main, { ...authority, participantId: "writer", repo: "api" });
		expect(worktree.repoRoot).toBe(api);
		expect(git(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toBe(join(api, ".git"));
		const linked = await test.worktrees.ensure(main, { ...authority, participantId: "designer", repo: "web" });
		expect(linked.repoRoot).toBe(web);

		const writerSession = join(test.root, "writer.jsonl");
		writeFileSync(writerSession, `${JSON.stringify({ type: "session", version: 3, id: "session_writer", timestamp: "2026-01-01T00:00:00.000Z", cwd: worktree.path })}\n`);
		await expect(test.registrations.register({ projectRoot: test.project, worktreePath: worktree.path, piSessionId: "session_writer", piSessionFile: writerSession })).rejects.toThrow("not a separate Git worktree");
		const writer = await test.registrations.register({ projectRoot: test.project, repo: "api", worktreePath: worktree.path, piSessionId: "session_writer", piSessionFile: writerSession });
		expect(test.store.read().targets[writer.targetKey]).toMatchObject({ repo: "api", repoRoot: api, worktreePath: worktree.path });
		const held = test.participants.acquire(writer, "review", "writer").participant;
		expect(test.store.read().participants[held.participantKey]).toMatchObject({ repo: "api", repoRoot: api, worktreePath: worktree.path });

		const listed = await test.worktrees.list(main);
		expect(listed.map((entry) => [entry.participantId, entry.repoRoot, entry.recorded])).toEqual([["writer", api, true], ["designer", web, false]]);

		test.participants.standDown(writer, held.participantKey);
		expect(await test.worktrees.ensure(main, { ...authority, participantId: "writer" })).toEqual(worktree);
		await expect(test.worktrees.ensure(main, { ...authority, participantId: "writer", repo: "web" })).rejects.toThrow("clean it up before choosing another repo");
		expect(await test.worktrees.remove(main, { ...authority, participantId: "writer", discardConfirmed: true })).toEqual({ removed: true });
		expect(test.store.read().participants[held.participantKey]?.repoRoot).toBeUndefined();
		expect(await test.worktrees.remove(main, { ...authority, participantId: "designer", repo: "web", discardConfirmed: true })).toEqual({ removed: true });
		expect(await test.worktrees.list(main)).toEqual([]);
	});

	it("binds a read-only agent at its repo and a writer in that repo's worktree", async () => {
		const test = setup("folder");
		const main = await test.registrations.register(test.input);
		const caller = test.participants.acquire(main, "review", "main").participant;
		const authority = { callerParticipantKey: caller.participantKey, expectedCallerGeneration: caller.generation, protocol: "review" };
		const api = join(test.project, "api");

		test.host.agents.set("reader", { tabId: "w1:t1", workspaceId: "w1", cwd: api, name: "reader" });
		await expect(test.bridges.bind(main, { ...authority, agentName: "reader", driver: "codex", profile: "read-only", participantId: "reader" })).rejects.toThrow("neither the project root");
		test.host.agents.set("stray", { tabId: "w1:t3", workspaceId: "w1", cwd: test.project, name: "stray" });
		await expect(test.bridges.bind(main, { ...authority, agentName: "stray", driver: "codex", profile: "read-only", participantId: "stray", repo: "api" })).rejects.toThrow("not its repo");
		const reader = await test.bridges.bind(main, { ...authority, agentName: "reader", driver: "codex", profile: "read-only", participantId: "reader", repo: "api" });
		expect(reader.cwd).toBe(api);
		expect(test.participants.list(main).find((participant) => participant.participantId === "reader")).toMatchObject({ repo: "api", repoRoot: api });
		expect(test.store.read().targets[reader.targetKey]).toMatchObject({ repoRoot: api });
		expect(test.store.read().targets[reader.targetKey]).not.toHaveProperty("worktreePath");
		expect(test.store.read().participants[reader.participantKey]).toMatchObject({ repo: "api", repoRoot: api });

		const worktree = await test.worktrees.ensure(main, { ...authority, participantId: "writer", repo: "api" });
		test.host.agents.set("writer", { tabId: "w1:t2", workspaceId: "w1", cwd: worktree.path, name: "writer" });
		const writer = await test.bridges.bind(main, { ...authority, agentName: "writer", driver: "claude-code", profile: "workspace-write", participantId: "writer", repo: "api" });
		expect(writer.cwd).toBe(worktree.path);
		expect(test.store.read().targets[writer.targetKey]).toMatchObject({ targetKey: deriveAgentTargetKey(test.project, "writer"), repoRoot: api, worktreePath: worktree.path });
		expect(test.store.read().participants[writer.participantKey]).toMatchObject({ repoRoot: api, worktreePath: worktree.path });
	});
});
