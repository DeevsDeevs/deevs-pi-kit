import { homedir } from "node:os";
import { join } from "node:path";
import { startRuntimeServer } from "./server.ts";

try {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write("Usage: node extensions/runtime/service/main.ts [--root PATH]\n");
	} else {
		const server = await startRuntimeServer({ root: options.root });
		process.stdout.write(`${JSON.stringify({ status: "ready", runtimeId: server.runtimeId, epoch: server.epoch, socket: server.socketPath })}\n`);
		let stopping = false;
		const stop = async () => {
			if (stopping) return;
			stopping = true;
			await server.close();
			process.exit(0);
		};
		process.once("SIGINT", () => void stop());
		process.once("SIGTERM", () => void stop());
	}
} catch (error) {
	process.stderr.write(`${JSON.stringify({ status: "error", code: errorCode(error), message: error instanceof Error ? error.message : String(error) })}\n`);
	process.exitCode = 1;
}

function parseArgs(args: string[]) {
	let root = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "runtime");
	let help = false;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			help = true;
			continue;
		}
		if (argument === "--root") {
			const value = args[++index];
			if (!value) throw new Error("--root requires a path.");
			root = value;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	return { root, help };
}

function errorCode(error: unknown): string {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
	return "internal";
}
