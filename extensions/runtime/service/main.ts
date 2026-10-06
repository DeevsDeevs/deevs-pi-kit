import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

// Only standalone Node needs a private TypeBox; Pi extensions use the host's peer.
registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier.replace(/^typebox(?=\/|$)/, "runtime-typebox"), context);
	},
});

try {
	const { startRuntimeServer } = await import("./server.ts");
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write("Usage: node extensions/runtime/service/main.ts [--root PATH]\n");
	} else {
		const server = await startRuntimeServer({ root: options.root });
		const ready = { status: "ready", runtimeId: server.runtimeId, socket: server.socketPath };
		process.stdout.write(`${JSON.stringify(ready)}\n`);
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
	let message = "Unknown runtime failure.";
	let candidateCode = "";
	try { message = String(error); } catch {}
	try {
		if (error instanceof Error) {
			message = String(error.message);
			if ("code" in error) candidateCode = String(error.code);
		}
	} catch {}
	const code = /^[A-Za-z][A-Za-z0-9_]*$/.test(candidateCode) ? candidateCode : "internal";
	process.stderr.write(`${JSON.stringify({ status: "error", code, message })}\n`);
	process.exitCode = 1;
}

interface RuntimeArgs {
	root: string;
	help: boolean;
}

function parseArgs(args: string[]): RuntimeArgs {
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

