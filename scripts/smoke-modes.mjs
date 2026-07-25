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
	input: `${JSON.stringify({ id: "commands", type: "get_commands" })}\n${JSON.stringify({ id: "state", type: "get_state" })}\n${JSON.stringify({ id: "jobs", type: "prompt", message: "/jobs" })}\n`,
	encoding: "utf8",
});
if (rpc.status !== 0) throw new Error(rpc.stderr || `RPC exited ${rpc.status}`);
const rows = rpc.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
const commands = rows.find((row) => row.id === "commands");
const state = rows.find((row) => row.id === "state");
const jobs = rows.find((row) => row.id === "jobs");
if (!commands?.success || !state?.success || !jobs?.success) throw new Error("RPC state/command smoke failed");
if (!rows.some((row) => row.type === "extension_ui_request" && row.method === "notify" && String(row.message).includes("No Jobs"))) throw new Error("RPC /jobs output was silent");
const names = new Set(commands.data.commands.map((command) => command.name));
for (const name of ["agents", "chains", "jobs", "mission", "todos"]) if (!names.has(name)) throw new Error(`Missing /${name}`);

for (const mode of ["print", "json"]) {
	const modeArgs = mode === "print" ? ["--print"] : ["--mode", "json", "--print"];
	const result = spawnSync("pi", [...modeArgs, "--no-session", "--no-extensions", "--extension", path.join(root, "extensions/jobs/index.ts"), "/jobs"], { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || `${mode} exited ${result.status}`);
	const combined = `${result.stdout}\n${result.stderr}`;
	if (!combined.includes("No Jobs")) throw new Error(`${mode} /jobs output was silent`);
	if (mode === "json") {
		const parsed = combined.split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
		if (!parsed.some((event) => event.type === "extension_output" && String(event.content).includes("No Jobs"))) throw new Error("JSON extension_output was missing");
	}
}

console.log(`Mode smoke passed: RPC ${commands.data.commands.length} commands, print command, JSONL command.`);
