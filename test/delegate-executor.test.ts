import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiCommand, DelegateExecutor } from "../extensions/subagents/executor.ts";
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
	it("leaves usage limits unbounded and uses the generous default wall limit", async () => {
		const executor = setup(() => completedScript());
		const run = await executor.start(input({ wallMs: undefined }));
		expect(run.spec.limits).toMatchObject({ wallMs: DEFAULT_TIMEOUT_MS });
		expect(run.spec.limits.turns).toBeUndefined();
		expect(run.spec.limits.tokens).toBeUndefined();
		expect(run.spec.limits.costUsd).toBeUndefined();
	});

	it("never falls back to default tools for read-only or empty tool selections", async () => {
		const executor = setup(() => completedScript());
		await expect(executor.start(input({ tools: [] }))).rejects.toThrow("tools must not be empty");
		const run = await executor.start(input());
		expect(run.spec.tools).not.toContain("bash");
		expect(run.spec.tools).not.toContain("read");
		const command = buildPiCommand(run.spec);
		const extensionPath = command.args[command.args.indexOf("--extension") + 1]!;
		expect(path.basename(extensionPath)).toBe("child-safety-runtime.ts");
		expect(existsSync(extensionPath)).toBe(true);
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
		const first = await executor.start(input());
		const resumed = await executor.resume({ runId: first.spec.id, task: "Review the fixes.", detach: false, wallMs: 2_000 });

		expect(resumed.spec.id).not.toBe(first.spec.id);
		expect(resumed.spec.agentId).toBe(first.spec.agentId);
		expect(resumed.spec.personaVersion).toBe(first.spec.personaVersion);
		expect(resumed.spec.context).toBe("resume");
		expect(resumed.runtime.output).toBe("resume");
	});
});

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
