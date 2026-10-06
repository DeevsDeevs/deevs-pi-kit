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

/** Decision 28, plus how messages reach a collaborator; Pi collaborators get the same lines. */
export const COLLABORATOR_GUIDANCE = "You collaborate with the lead, main. Messages reach you by themselves as \"Message from <name>: ...\"."
	+ " Reply or report with SendMessage (to: \"main\"); attach images by path. If the user changes your task in this tab, tell main with SendMessage.";

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
	const context = [
		input.personaPrompt ? collapsePrompt(input.personaPrompt) : undefined,
		COLLABORATOR_GUIDANCE,
	].filter(Boolean).join(" ");
	return {
		descriptorPath,
		serverName: `pi_kit_${createHash("sha256").update(input.targetKey).digest("hex").slice(0, 24)}`,
		server: { command: nodeExecutable, args: [endpoint, descriptorPath] },
		context,
	};
}
