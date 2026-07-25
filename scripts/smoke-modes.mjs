import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensions = readdirSync(path.join(root, "extensions"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => path.join(root, "extensions", entry.name, "index.ts"))
	.filter((file) => { try { return readdirSync(path.dirname(file)).includes("index.ts"); } catch { return false; } })
	.sort();
const args = extensions.flatMap((file) => ["--extension", file]);

const rpc = spawnSync("pi", ["--mode", "rpc", "--no-session", "--no-extensions", ...args], {
	cwd: root,
	input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n${JSON.stringify({ id: "state", type: "get_state" })}\n${JSON.stringify({ id: "jobs", type: "prompt", message: "/jobs" })}\n${JSON.stringify({ id: "cron", type: "prompt", message: "/cron" })}\n`,
	encoding: "utf8",
});
if (rpc.status !== 0) throw new Error(rpc.stderr || `RPC exited ${rpc.status}`);
const rows = rpc.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
const commands = rows.find((row) => row.id === "commands");
const state = rows.find((row) => row.id === "state");
const jobs = rows.find((row) => row.id === "jobs");
const cron = rows.find((row) => row.id === "cron");
if (!commands?.success || !state?.success || !jobs?.success || !cron?.success) throw new Error("RPC state/command smoke failed");
if (!rows.some((row) => row.type === "extension_ui_request" && row.method === "notify" && String(row.message).includes("No Jobs"))) throw new Error("RPC /jobs output was silent");
if (!rows.some((row) => row.type === "extension_ui_request" && row.method === "notify" && String(row.message).includes("No cron tasks"))) throw new Error("RPC /cron output was silent");
const names = new Set(commands.data.commands.map((command) => command.name));
for (const name of ["agents", "chains", "cron", "jobs", "mission", "todos"]) if (!names.has(name)) throw new Error(`Missing /${name}`);

for (const check of [
	{ extension: "jobs", command: "/jobs", expected: "No Jobs" },
	{ extension: "cron", command: "/cron", expected: "No cron tasks" },
]) for (const mode of ["print", "json"]) {
	const modeArgs = mode === "print" ? ["--print"] : ["--mode", "json", "--print"];
	const result = spawnSync("pi", [...modeArgs, "--no-session", "--no-extensions", "--extension", path.join(root, `extensions/${check.extension}/index.ts`), check.command], { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || `${mode} exited ${result.status}`);
	const combined = `${result.stdout}\n${result.stderr}`;
	if (!combined.includes(check.expected)) throw new Error(`${mode} ${check.command} output was silent`);
	if (mode === "json") {
		const parsed = combined.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
		if (!parsed.some((event) => event.type === "extension_output" && String(event.content).includes(check.expected))) throw new Error(`JSON ${check.command} extension_output was missing`);
	}
}

console.log(`Mode smoke passed: RPC ${commands.data.commands.length} commands, print commands, JSONL commands.`);
