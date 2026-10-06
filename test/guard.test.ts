import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { guardArgv, guardBashCall, guardShell, loadGuardConfig, type GuardConfig } from "../extensions/shared/guard.ts";

const HOOK = join(import.meta.dirname, "../extensions/shared/guard-hook.mjs");
const options = (config: GuardConfig = {}) => ({ cwd: "/work/proj", home: "/home/u", tmpDir: "/var/tmp-x", config });
const blocked = (command: string, config?: GuardConfig) => expect(guardShell(command, options(config)), command).toBeDefined();
const allowed = (command: string, config?: GuardConfig) => expect(guardShell(command, options(config)), command).toBeUndefined();
const reason = (command: string, config?: GuardConfig) => guardShell(command, options(config)) ?? "";

describe("guard: detached processes", () => {
	it("blocks trailing and embedded backgrounding", () => {
		for (const command of ["sleep 100 &", "sleep 100 & ", "echo a; sleep 100 &", "cmd1 & cmd2", "for f in a b; do sleep 1 & done", "{ sleep 100 & }", "(sleep 100 &)"]) blocked(command);
	});

	it("blocks nohup/setsid/disown/coproc bare and behind wrappers", () => {
		for (const command of ["nohup sleep 300", "setsid node worker.js", "sleep 1; disown", "coproc sleep 300", "sudo -s nohup sleep 300", "sudo -i setsid x", "csh -c 'sleep 1 &'", "tcsh -c 'x &'"]) blocked(command);
	});

	it("closes the comment/heredoc quote-swallow bypass (FN-1)", () => {
		blocked("echo hi # don't care\nnohup sleep 300 &");
		blocked("npm run build # doesn't matter\nsetsid node worker.js");
		blocked("echo \"unterminated\nsleep 300 &");
	});

	it("does not misread test builtins, arithmetic, redirections, or comments", () => {
		allowed("[ -f package.json ] && npm test");
		allowed("[[ -d src ]] && echo ok");
		allowed("if [ -f a ]; then echo hi; fi");
		allowed("while [ -f a ]; do sleep 1; done");
		allowed("echo $((MASK & FLAG))");
		allowed("if (( a & b )); then echo hi; fi");
		allowed("npm test >& /dev/null");
		allowed("sleep 100 >& out");
		allowed("exec 2>&-");
		allowed("make build # runs tests & lints");
		allowed("echo hi # background & later");
	});

	it("keeps allowing quoted operators and detach words in arguments", () => {
		allowed("echo \"a & b\"");
		allowed("curl 'https://x/?a=1&b=2'");
		allowed("grep -r 'nohup' .");
		allowed("rg nohup .");
		allowed("ls *.ts");
		allowed("nohup=1 echo hi");
		allowed("command -v nohup");
		allowed("timeout 5 npm test");
		allowed("nice -n 5 npm test");
		allowed("echo 'nohup sleep 1 & setsid x'");
	});

	it("mirrors the shell rules through the argv path", () => {
		expect(guardArgv(["rg", "nohup", "."])).toBeUndefined();
		expect(guardArgv(["coproc", "sleep", "300"])).toBeDefined();
		expect(guardArgv(["csh", "-c", "sleep 1 &"])).toBeDefined();
		expect(guardArgv(["bash", "-lc", "[ -f x ] && npm test"])).toBeUndefined();
	});
});

describe("guard: heredocs", () => {
	it("reads data heredoc bodies as text, not commands (A15)", () => {
		allowed("cat <<'EOF' > notes.md\n* don't & nohup here\n$VAR line\nsetsid is a word\nEOF");
		allowed("cat > plan.md <<EOF\n- it's (1) & done\n* bullet\nEOF\necho written");
		allowed("cat <<-EOF\n\tindented * line & more\n\tEOF\necho done");
		allowed("python3 - <<'PY'\nimport os; print('a & b')\nPY");
		allowed("cat <<A <<B\nfirst don't\nA\nsecond \"\nB");
		allowed("cat <<< \"a & b\"");
	});

	it("keeps the Claude-style commit message heredoc inside $(...) (A15)", () => {
		allowed("git commit -m \"$(cat <<'EOF'\nfix(guard): don't refuse \"quoted\" text\n\n1) step & more\nEOF\n)\"");
		allowed("git commit -F - <<'EOF'\nfeat: x\n\nIt's done; nohup is mentioned & fine\nEOF");
	});

	it("checks substitutions inside unquoted bodies and skips them in quoted ones", () => {
		blocked("cat <<EOF\n$(nohup sleep 300 &)\nEOF");
		blocked("cat <<EOF\nnote `setsid node w`\nEOF");
		allowed("cat <<EOF\nHello $(whoami), it's $(date +%F)\nEOF");
		allowed("cat <<'EOF'\n$(nohup sleep 300 &)\nEOF");
		allowed("cat <<EOF\nescaped \\$(nohup x &)\nEOF");
	});

	it("checks bodies fed to a shell as scripts", () => {
		blocked("bash <<'EOF'\nnohup sleep 300 &\nEOF");
		blocked("cat <<'EOF' | sh\nsetsid node worker.js\nEOF");
		blocked("bash -s <<EOF\ngit push --force origin main\nEOF");
		allowed("bash <<'EOF'\nnpm test\necho \"don't\"\nEOF");
	});

	it("checks commands after the body and fails closed on broken syntax", () => {
		blocked("cat <<'EOF'\nbody\nEOF\nnohup sleep 300 &");
		blocked("cat <<A <<B\na\nA\nb\nB\nsetsid x");
		blocked("cat <<<x\nnohup y");
		blocked("cat <<'EOF\nbody");
	});
});

describe("guard: command substitution", () => {
	it("checks the contents of $(...) and backticks", () => {
		blocked("echo $(nohup sleep 300 &)");
		blocked("echo \"$(setsid node worker.js)\"");
		blocked("echo $(echo $(nohup x))");
		blocked("echo `nohup x`");
		blocked("echo $(date");
		blocked("echo `date");
	});

	it("allows ordinary substitutions, including quotes and parens inside", () => {
		allowed("echo \"$(git rev-parse HEAD)\"");
		allowed("x=$(date +%s); echo $x");
		allowed("echo $(echo \"a)b\")");
		allowed("for f in $(ls src); do echo $f; done");
		allowed("echo \"sum: $(( $(wc -l < a) + 1 ))\"");
		allowed("diff <(sort a) <(sort b)");
	});

	it("still refuses a command name it cannot read", () => {
		blocked("$(printf nohup) sleep 300");
		blocked("runner=setsid; $runner node worker.js");
	});
});

describe("guard: shell functions", () => {
	it("allows functions that run their arguments (A15)", () => {
		allowed("run() { echo \"== $1\"; shift; \"$@\"; }\nrun lint npm run lint\nrun test npm test");
		allowed("function retry { for i in 1 2 3; do \"$@\" && return 0; done; return 1; }; retry npm test");
		allowed("log() { printf '%s\\n' \"$*\"; }; log done");
	});

	it("blocks a local function called with a detach command", () => {
		blocked("run() { \"$@\"; }; run nohup sleep 300");
		blocked("function go { $1 x; }; go setsid");
	});

	it("reads positional parameters outside a function body as unknown commands", () => {
		blocked("bash -c '\"$@\"' _ setsid sleep 100");
		blocked("\"$@\"");
		blocked("$1 x");
		blocked("set -- setsid sleep 100; \"$@\"");
		blocked("run() { echo; }; \"$@\"");
		expect(guardArgv(["sh", "-c", "$1 x", "_", "nohup"])).toBeDefined();
	});
});

describe("guard: force push", () => {
	it("blocks forced pushes to protected or unnamed branches", () => {
		for (const command of [
			"git push --force origin main",
			"git push -f origin master",
			"git push origin +main",
			"git push --force-with-lease origin release/1.2",
			"git push --force-with-lease=main:abc origin main",
			"git push --force",
			"git push -f origin",
			"git -C repo push -f origin HEAD",
			"git push origin feature:main -f",
			"git push origin refs/heads/main --force",
			"git push --mirror backup",
			"git push -fu origin main",
			"cd repo && git push -f origin main",
			"env GIT_TRACE=1 git push -f origin main",
			"bash -c 'git push --force origin main'",
			"git -c core.editor=true push -f origin '+refs/heads/*:refs/heads/*'",
			"git push origin :main",
			"git push origin :refs/heads/release/1",
			"git push --delete origin main",
			"git push -d origin master",
			"git push origin --delete feature/x main",
		]) expect(reason(command), command).toMatch(/^Force push to a protected branch/);
	});

	it("allows deleting a named feature branch", () => {
		allowed("git push origin :feature/x");
		allowed("git push --delete origin feature/x");
		allowed("git push origin :");
	});

	it("allows ordinary pushes and forced pushes to named feature branches", () => {
		allowed("git push origin main");
		allowed("git push -u origin HEAD");
		allowed("git push --force-with-lease origin feature/x");
		allowed("git push origin +feature/x");
		allowed("git push -o ci.skip origin main");
		allowed("git commit -m 'git push -f origin main'");
		allowed("echo git push --force origin main");
	});

	it("is switched off by guard.forcePush:false", () => {
		allowed("git push --force origin main", { forcePush: false });
	});
});

describe("guard: rm -rf", () => {
	it("blocks recursive removal outside the cwd and the temp directories", () => {
		for (const command of [
			"rm -rf ~/x",
			"rm -rf /",
			"rm -rf ..",
			"rm -rf ../other",
			"rm -rf /work/proj",
			"rm -rf \"$HOME/x\"",
			"rm -rf $BUILD_DIR",
			"rm -rf \"$(mktemp -d)\"",
			"rm -r /etc/x",
			"rm -Rf /x",
			"rm --recursive --force /x",
			"rm -rf build /etc",
			"rm -rf /tmp",
			"rm -rf ~other/x",
			"cd / && rm -rf etc",
			"cd ~ && rm -rf proj",
			"cd \"$X\" && rm -rf build",
			"cd && rm -rf x",
			"sudo rm -rf /var/lib/x",
			"bash -c 'rm -rf /'",
		]) expect(reason(command), command).toMatch(/^Recursive rm outside/);
	});

	it("allows removal inside the cwd and the temp directories", () => {
		allowed("rm -rf build");
		allowed("rm -rf ./dist/* node_modules/.cache");
		allowed("rm -rf /work/proj/node_modules");
		allowed("rm -rf /tmp/x");
		allowed("rm -rf $TMPDIR/x");
		allowed("rm -rf \"${TMPDIR}/y\"");
		allowed("rm -rf /var/tmp-x/z");
		allowed("rm -rf \"$PWD/out\"");
		allowed("rm -f /etc/foo");
		allowed("cd /tmp && rm -rf scratch");
		allowed("cd sub && rm -rf ../build");
		allowed("x=$(cd /; pwd); rm -rf build");
		allowed("echo rm -rf /");
		allowed("rm -rf -- -weird");
	});

	it("is switched off by guard.rmRf:false", () => {
		allowed("rm -rf /", { rmRf: false });
	});
});

describe("guard: block patterns and switches", () => {
	const config = { block: ["terraform destroy", "npm publish", "  "] };

	it("blocks a pattern's executable with its words in order, through wrappers and argv", () => {
		expect(reason("terraform -chdir=infra destroy -auto-approve", config)).toBe("Blocked by the guard.block pattern \"terraform destroy\".");
		blocked("cd pkg && npm publish --dry-run", config);
		blocked("sudo npm publish", config);
		blocked("echo $(npm publish)", config);
		expect(guardArgv(["/usr/bin/npm", "publish"], options(config))).toBeDefined();
		allowed("terraform plan", config);
		allowed("echo npm publish", config);
		allowed("npm test", config);
	});

	it("turns the detach rule off without disabling the others", () => {
		allowed("sleep 1 &", { detached: false });
		allowed("nohup npm test", { detached: false });
		blocked("nohup rm -rf /", { detached: false });
		blocked("setsid git push -f origin main", { detached: false });
	});
});

describe("guard: configuration and hooks", () => {
	const fixture = () => {
		const root = mkdtempSync(join(tmpdir(), "pi-kit-guard-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		return { root, agentDir, cwd };
	};

	it("takes switches from the global file only and adds up both block lists", () => {
		const { agentDir, cwd } = fixture();
		writeFileSync(join(agentDir, "pi-kit.json"), JSON.stringify({ models: { sol: "x" }, guard: { rmRf: false, block: ["kubectl delete"] } }));
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ guard: { rmRf: true, detached: false, forcePush: false, block: ["npm publish"] } }));
		expect(loadGuardConfig(cwd, agentDir)).toEqual({ rmRf: false, block: ["kubectl delete", "npm publish"] });
	});

	it("never lets a project file switch a rule off", () => {
		const { cwd } = fixture();
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ guard: { rmRf: false, detached: false, forcePush: false } }));
		expect(guardBashCall("rm -rf ~", cwd)?.reason).toMatch(/^Recursive rm outside/);
		expect(guardBashCall("nohup sleep 999 &", cwd)?.reason).toMatch(/^Detached process launch/);
		expect(guardBashCall("git push -f origin main", cwd)?.reason).toMatch(/^Force push to a protected branch/);
	});

	it("keeps every rule on and the valid block patterns when a file is broken", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { agentDir, cwd } = fixture();
		writeFileSync(join(agentDir, "pi-kit.json"), "{ not json");
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ guard: { detached: "false", block: ["npm publish"] } }));
		expect(loadGuardConfig(cwd, agentDir)).toEqual({ block: ["npm publish"] });
		expect(warn).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});

	it("cleans only inside the project root, whatever cwd the command runs in", () => {
		const { cwd } = fixture();
		expect(guardBashCall("rm -rf etc", "/", cwd)?.reason).toMatch(/^Recursive rm outside/);
		expect(guardBashCall("rm -rf /home/u", "/", cwd)?.reason).toMatch(/^Recursive rm outside/);
		expect(guardBashCall("rm -rf build", join(cwd, "pkg"), cwd)).toBeUndefined();
		expect(guardArgv(["rm", "-rf", "etc"], { cwd: "/", root: cwd })).toMatch(/^Recursive rm outside/);
	});

	it("answers a Pi tool_call with the project's rules", () => {
		const { cwd } = fixture();
		expect(guardBashCall("npm publish", cwd)).toBeUndefined();
		writeFileSync(join(cwd, ".pi", "pi-kit.json"), JSON.stringify({ guard: { block: ["npm publish"] } }));
		expect(guardBashCall("npm publish", cwd)).toEqual({ block: true, reason: "Blocked by the guard.block pattern \"npm publish\"." });
		expect(guardBashCall("nohup x &", cwd)?.reason).toMatch(/^Detached process launch/);
	});

	it("prints a PreToolUse deny decision from the CLI hook", () => {
		const { root, agentDir, cwd } = fixture();
		const hook = (input: object) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
		const denied = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command: "git push --force origin main" } });
		expect(denied.status).toBe(0);
		expect(JSON.parse(denied.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^Force push to a protected branch/) } });
		expect(JSON.parse(hook({ hook_event_name: "PreToolUse", tool_name: "shell", cwd, tool_input: { command: ["bash", "-lc", "nohup x &"] } }).stdout).hookSpecificOutput.permissionDecision).toBe("deny");
		const passed = hook({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command: `rm -rf ${join(root, "project", "build")}` } });
		expect([passed.status, passed.stdout]).toEqual([0, ""]);
		expect(hook({ hook_event_name: "PreToolUse", tool_name: "Read", cwd, tool_input: { file_path: "/etc/passwd" } }).stdout).toBe("");
	});
});
