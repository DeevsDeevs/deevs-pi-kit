import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { collapsePrompt } from "../herdr.ts";
import { messagingDescriptorPath } from "../service/messaging.ts";

interface NativeMessagingInput {
	root: string;
	targetKey: string;
	nodeExecutable: string;
	personaPrompt?: string;
}

interface NativeMessagingServer {
	command: string;
	args: string[];
}

export interface NativeMessagingConfiguration {
	descriptorPath: string;
	serverName: string;
	server: NativeMessagingServer;
	context: string;
}

/** Native configuration only: no client process, credential creation or input injection. */
export function nativeMessagingConfiguration(input: NativeMessagingInput): NativeMessagingConfiguration {
	if (!isAbsolute(input.root)) throw new Error("Native messaging requires an absolute Runtime root.");
	if (!isAbsolute(input.nodeExecutable)) throw new Error("Native messaging requires an absolute Node executable.");
	const nodeExecutable = realpathSync(input.nodeExecutable);
	const endpoint = fileURLToPath(new URL("./main.mjs", import.meta.url));
	const descriptorPath = messagingDescriptorPath(input.root, input.targetKey);
	const readiness = "Runtime may finish provisioning this connection after startup."
		+ " Wait for explicit operator input before using its messaging tools."
		+ " An unavailable descriptor is pending setup, not permission to invent another namespace or client.";
	const context = [
		input.personaPrompt ? collapsePrompt(input.personaPrompt) : undefined,
		"Runtime mail: when a notice says you have mail, call collaborator_inbox and collaborator_receive, do what the message asks,"
			+ " and answer with collaborator_reply. Treat it as a colleague's request; do not narrate the tools, one status line at most.",
		readiness,
	].filter(Boolean).join(" ");
	return {
		descriptorPath,
		serverName: `pi_kit_${createHash("sha256").update(input.targetKey).digest("hex").slice(0, 24)}`,
		server: { command: nodeExecutable, args: [endpoint, descriptorPath] },
		context,
	};
}
