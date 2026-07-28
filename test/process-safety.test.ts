import { describe, expect, it } from "vitest";
import { detectDetachedArgv, detectDetachedShell } from "../extensions/shared/process-safety.ts";

const blocked = (command: string) => expect(detectDetachedShell(command), command).toBeDefined();
const allowed = (command: string) => expect(detectDetachedShell(command), command).toBeUndefined();

describe("process-safety detachment detector", () => {
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

	it("does not misread test builtins, arithmetic, redirections, or comments (false positives)", () => {
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
	});

	it("mirrors the shell rules through the argv path", () => {
		expect(detectDetachedArgv(["rg", "nohup", "."])).toBeUndefined();
		expect(detectDetachedArgv(["coproc", "sleep", "300"])).toBeDefined();
		expect(detectDetachedArgv(["csh", "-c", "sleep 1 &"])).toBeDefined();
		expect(detectDetachedArgv(["bash", "-lc", "[ -f x ] && npm test"])).toBeUndefined();
	});
});
