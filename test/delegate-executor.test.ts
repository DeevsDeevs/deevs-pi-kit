import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPiCommand, DelegateExecutor, resolvePiInvocation, scriptRuntimeCandidates } from "../extensions/subagents/executor.ts";
import { DEFAULT_TIMEOUT_MS } from "../extensions/subagents/config.ts";
import type { DelegateRunSpec, DelegateStartInput } from "../extensions/subagents/runtime-types.ts";

const roots: string[] = [];
const executors: DelegateExecutor[] = [];

afterEach(() => {
	for (const executor of executors.splice(0)) executor.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(script: (spec: DelegateRunSpec) => string): DelegateExecutor {
	const root = mkdtempSync(path.join(tmpdir(), "delegate-executor-"));
	roots.push(root);
	const executor = new DelegateExecutor({
		artifactsRoot: root,
		command: (spec) => ({ command: process.execPath, args: ["-e", script(spec)] }),
	});
	executors.push(executor);
	return executor;
}

function input(overrides: Partial<DelegateStartInput> = {}): DelegateStartInput {
	return {
		persona: "reviewer",
		personaBody: "Review correctness and report evidence.",
		personaTools: ["safe_read", "safe_list", "safe_search"],
		task: "Review one file.",
		cwd: process.cwd(),
		detach: false,
		wallMs: 2_000,
		...overrides,
	};
}

function completedScript(output = "Ship"): string {
	const message = { role: "assistant", content: [{ type: "text", text: output }], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 } } };
	return `const message=${JSON.stringify(message)}; console.log(JSON.stringify({type:'message_end',message})); console.log(JSON.stringify({type:'turn_end',message,toolResults:[]})); console.log(JSON.stringify({type:'agent_settled'}));`;
}

describe("DelegateExecutor", () => {
	it("resolves Pi and worker runtimes across source and standalone installs", () => {
		const args = ["--mode", "json"];
		const sourceCli = path.join(process.cwd(), "test/delegate-executor.test.ts");
		expect(resolvePiInvocation(args, sourceCli, "/usr/bin/node")).toEqual({ command: "/usr/bin/node", args: [sourceCli, ...args] });
		expect(resolvePiInvocation(args, "/$bunfs/root/pi", "/opt/pi")).toEqual({ command: "/opt/pi", args });
		expect(resolvePiInvocation(args, "", "/usr/bin/bun")).toEqual({ command: "pi", args });
		expect(scriptRuntimeCandidates("/usr/bin/node")).toEqual(["/usr/bin/node"]);
		expect(scriptRuntimeCandidates("/opt/pi", { NODE: "/usr/local/bin/node" } as NodeJS.ProcessEnv)).toEqual(["/usr/local/bin/node", "node", "bun"]);
	});

	it("leaves usage limits unbounded and uses the generous default wall limit", async () => {
		const executor = setup(() => completedScript());
		const run = await executor.start(input({ wallMs: undefined }));
		expect(run.spec.limits).toMatchObject({ wallMs: DEFAULT_TIMEOUT_MS });
		expect(run.spec.limits.turns).toBeUndefined();
		expect(run.spec.limits.tokens).toBeUndefined();
		expect(run.spec.limits.costUsd).toBeUndefined();
		expect(readFileSync(run.spec.systemPromptPath, "utf8")).toContain("Provider-turn limit: unbounded");
	});

	it("never falls back to default tools for read-only or empty tool selections", async () => {
		const executor = setup(() => completedScript());
		await expect(executor.start(input({ tools: [] }))).rejects.toThrow("tools must not be empty");
		await expect(executor.start(input({ tools: ["read"] }))).rejects.toThrow("Allowed tools: safe_list, safe_read, safe_search");
		const run = await executor.start(input({ turns: 2 }));
		expect(run.spec.tools).not.toContain("bash");
		expect(run.spec.tools).not.toContain("read");
		const command = buildPiCommand(run.spec);
		const extensionPath = command.args[command.args.indexOf("--extension") + 1]!;
		expect(path.basename(extensionPath)).toBe("child-safety-runtime.ts");
		expect(existsSync(extensionPath)).toBe(true);
		expect(readFileSync(run.spec.systemPromptPath, "utf8")).toContain("Provider-turn limit: 2");
	});

	it("settles only after the isolated child exits and records exact run usage", async () => {
		const executor = setup(() => completedScript());
		const run = await executor.start(input());

		expect(run.runtime.status).toBe("completed");
		expect(run.runtime.settled).toBe(true);
		expect(run.runtime.output).toBe("Ship");
		expect(run.runtime.turns).toBe(1);
		expect(run.runtime.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, costUsd: 0.01 });
		expect(existsSync(run.spec.resultPath)).toBe(true);
		expect(existsSync(run.spec.transcriptPath)).toBe(true);
		expect(statSync(run.spec.resultPath, { bigint: true }).mtimeNs).toBeLessThanOrEqual(statSync(run.spec.runtimePath, { bigint: true }).mtimeNs);
	});

	it("does not overwrite a fast worker terminal state while establishing process identity", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "delegate-slow-identity-"));
		roots.push(root);
		const marker = path.join(root, "first-ps");
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		const ps = path.join(bin, "ps");
		writeFileSync(ps, `#!/bin/sh\nif mkdir ${JSON.stringify(marker)} 2>/dev/null; then sleep 1; fi\nexec /bin/ps "$@"\n`);
		chmodSync(ps, 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		try {
			const executor = setup(() => completedScript("fast"));
			const run = await executor.start(input({ wallMs: 4_000 }));
			expect(run.runtime.status).toBe("completed");
			expect(run.runtime.output).toBe("fast");
			expect(run.runtime.workerPid).toBeTypeOf("number");
		} finally {
			process.env.PATH = previousPath;
		}
	});

	it("does not publish a requested limit as terminal before child close", async () => {
		const executor = setup(() => `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),200)); const message={role:'assistant',content:[{type:'text',text:'partial'}],usage:{input:80,output:30,cost:{total:0.1}}}; console.log(JSON.stringify({type:'message_end',message})); console.log(JSON.stringify({type:'turn_end',message,toolResults:[]})); setInterval(()=>{},1000);`);
		const startedAt = Date.now();
		const run = await executor.start(input({ tokens: 50 }));
		expect(run.runtime.status).toBe("limited");
		expect(run.runtime.endedAt).toBeDefined();
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
	});

	it("kills stubborn same-group descendants before terminal settlement", async () => {
		const executor = setup(() => {
			const pidFile = path.join(roots.at(-1)!, "descendant.pid");
			return `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.on('SIGTERM',()=>process.exit(0));const message={role:'assistant',content:[{type:'text',text:'partial'}],usage:{input:80,output:30,cost:{total:0.1}}};console.log(JSON.stringify({type:'message_end',message}));console.log(JSON.stringify({type:'turn_end',message,toolResults:[]}));setInterval(()=>{},1000);`;
		});
		const run = await executor.start(input({ tokens: 50 }));
		const pidFile = path.join(path.dirname(path.dirname(run.spec.artifactsDir)), "descendant.pid");
		const descendantPid = Number((await import("node:fs")).readFileSync(pidFile, "utf8"));
		expect(run.runtime.status).toBe("limited");
		expect(isAlive(descendantPid)).toBe(false);
	});

	it("does not infer terminal status from English stderr prose", async () => {
		const executor = setup(() => `console.error('credentials required: sign in'); setTimeout(()=>process.exit(1),100);`);
		const run = await executor.start(input());
		expect(run.runtime.status).toBe("failed");
		expect(run.runtime.error).toContain("credentials required");
	});

	it("does not infer partial status from prose output without typed settlement", async () => {
		const executor = setup(() => `const message={role:'assistant',content:[{type:'text',text:'unfinished prose'}],usage:{input:1,output:1,cost:{total:0}}}; console.log(JSON.stringify({type:'message_end',message})); process.exit(1);`);
		const run = await executor.start(input());
		expect(run.runtime.output).toBe("unfinished prose");
		expect(run.runtime.status).toBe("failed");
	});

	it("enforces token limits after one documented provider-call overshoot", async () => {
		const executor = setup(() => `const message={role:'assistant',content:[{type:'text',text:'partial'}],usage:{input:80,output:30,cost:{total:0.1}}}; console.log(JSON.stringify({type:'message_end',message})); console.log(JSON.stringify({type:'turn_end',message,toolResults:[]})); setInterval(()=>{},1000);`);
		const run = await executor.start(input({ tokens: 50 }));

		expect(run.runtime.status).toBe("limited");
		expect(run.runtime.limitReason).toBe("tokens");
		expect(run.runtime.usage.inputTokens + run.runtime.usage.outputTokens).toBe(110);
		expect(run.runtime.error).toContain("may overshoot");
	});

	it("enforces wall limits and hard cancellation", async () => {
		const timeoutExecutor = setup(() => "setInterval(()=>{},1000)");
		const timedOut = await timeoutExecutor.start(input({ wallMs: 100 }));
		expect(timedOut.runtime.status).toBe("timeout");
		expect(timedOut.runtime.limitReason).toBe("wall");

		const cancelExecutor = setup(() => "setInterval(()=>{},1000)");
		const active = await cancelExecutor.start(input({ detach: true, wallMs: 5_000 }));
		const cancelled = await cancelExecutor.cancel(active.spec.id);
		expect(cancelled.runtime.status).toBe("cancelled");
	});

	it("reattaches to a detached worker after parent restoration", async () => {
		const executor = setup(() => {
			const script = completedScript("restored");
			return `setTimeout(()=>{${script}},200);`;
		});
		const started = await executor.start(input({ detach: true }));
		const root = path.dirname(path.dirname(started.spec.artifactsDir));
		executor.dispose();

		const restoredExecutor = new DelegateExecutor({ artifactsRoot: root });
		executors.push(restoredExecutor);
		const restored = await restoredExecutor.restore(process.cwd());
		expect(restored.map((run) => run.spec.id)).toContain(started.spec.id);
		const settled = await restoredExecutor.wait(started.spec.id);
		expect(settled.runtime.status).toBe("completed");
		expect(settled.runtime.output).toBe("restored");
	});

	it("polls terminal state when a filesystem watch event is missed", async () => {
		const executor = setup(() => `setTimeout(()=>{${completedScript("polled")}},500);`);
		const started = await executor.start(input({ detach: true }));
		(executor as unknown as { closeWatcher(id: string): void }).closeWatcher(started.spec.id);
		const settled = await executor.wait(started.spec.id, 2_000);
		expect(settled.runtime.status).toBe("completed");
		expect(settled.runtime.output).toBe("polled");
	});

	it("rechecks terminal state after subscribing to wait events", async () => {
		const executor = new DelegateExecutor();
		executors.push(executor);
		const running = { spec: { id: "race" }, runtime: { status: "running", startedAt: 0 } };
		const completed = { spec: { id: "race" }, runtime: { status: "completed", startedAt: 0, endedAt: 1 } };
		(executor as any).runs.set("race", running);
		const refresh = vi.spyOn(executor as any, "refresh").mockReturnValueOnce(running).mockReturnValue(completed);

		await expect(executor.wait("race", 100)).resolves.toBe(completed);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("does not signal processes whose persisted identity no longer matches", async () => {
		const executor = setup(() => "setInterval(()=>{},1000)");
		const started = await executor.start(input({ detach: true, wallMs: 5_000 }));
		const running = await executor.wait(started.spec.id, 150);
		writeFileSync(running.spec.runtimePath, JSON.stringify({ ...running.runtime, workerIdentity: "reused-worker" }));
		const cancelled = await executor.cancel(started.spec.id);
		expect(cancelled.runtime.status).toBe("lost");
		if (running.runtime.workerPid) expect(isAlive(running.runtime.workerPid)).toBe(true);
		if (running.runtime.childPid) expect(isAlive(running.runtime.childPid)).toBe(true);
		if (running.runtime.childPid) try { process.kill(-running.runtime.childPid, "SIGKILL"); } catch {}
		if (running.runtime.workerPid) try { process.kill(-running.runtime.workerPid, "SIGKILL"); } catch {}
	});

	it("marks an already-dead detached worker lost during restore", async () => {
		const executor = setup(() => "setInterval(()=>{},1000)");
		const started = await executor.start(input({ detach: true, wallMs: 5_000 }));
		const running = await executor.wait(started.spec.id, 100);
		const root = path.dirname(path.dirname(started.spec.artifactsDir));
		executor.dispose();
		if (running.runtime.childPid) try { process.kill(-running.runtime.childPid, "SIGKILL"); } catch {}
		if (running.runtime.workerPid) try { process.kill(-running.runtime.workerPid, "SIGKILL"); } catch {}
		await new Promise((resolve) => setTimeout(resolve, 25));

		const restoredExecutor = new DelegateExecutor({ artifactsRoot: root });
		executors.push(restoredExecutor);
		const [lost] = (await restoredExecutor.restore(process.cwd())).filter((run) => run.spec.id === started.spec.id);
		expect(lost?.runtime.status).toBe("lost");
	});

	it("resumes the same persistent agent identity in a new run", async () => {
		const executor = setup((spec) => {
			mkdirSync(spec.sessionDir, { recursive: true });
			writeFileSync(path.join(spec.sessionDir, `${spec.id}.jsonl`), "{}\n");
			return completedScript(spec.context);
		});
		const first = await executor.start(input({ admissionKey: "review-original" }));
		const resumed = await executor.resume({ runId: first.spec.id, task: "Review the fixes.", detach: false, wallMs: 2_000, turns: 2 });

		expect(resumed.spec.id).not.toBe(first.spec.id);
		expect(resumed.spec.agentId).toBe(first.spec.agentId);
		expect(resumed.spec.personaVersion).toBe(first.spec.personaVersion);
		expect(resumed.spec.context).toBe("resume");
		expect(resumed.spec.admissionKey).toBeUndefined();
		expect(resumed.runtime.output).toBe("resume");
		expect(readFileSync(resumed.spec.systemPromptPath, "utf8")).toContain("Provider-turn limit: 2");
	});
});

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
