/* oxlint-disable anti-slop/no-runtime-typeof -- Private credential JSON is validated at its filesystem boundary. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { record } from "./mcp/client.ts";

export interface ManagedAgentBinding {
	owner: { sessionId: string; sessionFile: string; cwd: string };
	projectRoot: string;
	cwd: string;
	bridgeId: string;
	targetKey: string;
	driver: "claude-code" | "codex";
	clientGeneration: string;
	configurationHash: string;
	holderGeneration: string;
	paneId: string;
	terminalId: string;
	agentSession: { source: string; agent: string; kind: "id" | "path"; value: string };
	messagingConfigured: boolean;
}

const unavailable = () => new Error("Private native control credentials are unavailable or conflict with their exact binding; preserve the original authority for explicit recovery.");
const maxBytes = 4096;

export function managedAgentCredentialPath(root: string, binding: Pick<ManagedAgentBinding, "targetKey" | "clientGeneration">): string {
	return join(root, `native-control-${createHash("sha256").update(JSON.stringify([binding.targetKey, binding.clientGeneration])).digest("hex")}.json`);
}

function privateRoot(root: string): void {
	const info = lstatSync(root);
	if (!info.isDirectory() || (info.mode & 0o077) !== 0 || process.getuid?.() !== info.uid) throw unavailable();
}

export function readManagedAgentCredentials(root: string, binding: ManagedAgentBinding): { launchToken: string; reconnectToken: string } {
	return loadCredentials(root, binding, false);
}

function syncDirectory(root: string): void {
	const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { fsyncSync(directory); } finally { closeSync(directory); }
}

function loadCredentials(root: string, binding: ManagedAgentBinding, synchronize: boolean) {
	let fd: number | undefined;
	try {
		privateRoot(root);
		const path = managedAgentCredentialPath(root, binding);
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const info = fstatSync(fd);
		if (!info.isFile() || (info.mode & 0o077) !== 0 || process.getuid?.() !== info.uid || info.size > maxBytes) throw unavailable();
		const bytes = Buffer.alloc(maxBytes + 1);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		const after = fstatSync(fd);
		const named = lstatSync(path);
		if (count !== info.size || count > maxBytes || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || named.dev !== info.dev || named.ino !== info.ino) throw unavailable();
		const value: unknown = JSON.parse(bytes.subarray(0, count).toString("utf8"));
		if (!record(value) || Object.keys(value).length !== 4 || value.version !== 1 || !isDeepStrictEqual(value.binding, binding) || typeof value.launchToken !== "string" || value.launchToken.length === 0 || value.launchToken.length > 512 || typeof value.reconnectToken !== "string" || value.reconnectToken.length === 0 || value.reconnectToken.length > 200) throw unavailable();
		if (synchronize) { fsyncSync(fd); syncDirectory(root); }
		return { launchToken: value.launchToken, reconnectToken: value.reconnectToken };
	} catch { throw unavailable(); }
	finally { if (fd !== undefined) closeSync(fd); }
}

export function persistManagedAgentCredentials(root: string, binding: ManagedAgentBinding, credentials: { launchToken?: string; reconnectToken: string }): void {
	privateRoot(root);
	const path = managedAgentCredentialPath(root, binding);
	const verifyExisting = () => {
		const stored = loadCredentials(root, binding, true);
		if (stored.reconnectToken !== credentials.reconnectToken || credentials.launchToken !== undefined && stored.launchToken !== credentials.launchToken) throw unavailable();
	};
	if (credentials.launchToken === undefined) { verifyExisting(); return; }
	const bytes = `${JSON.stringify({ version: 1, binding, launchToken: credentials.launchToken, reconnectToken: credentials.reconnectToken })}\n`;
	if (Buffer.byteLength(bytes) > maxBytes) throw unavailable();
	let fd: number;
	try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") { verifyExisting(); return; }
		throw unavailable();
	}
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
		syncDirectory(root);
	} finally { closeSync(fd); }
	// Failed writes/syncs deliberately retain their private artifact; never repair uncertain credentials by overwriting it.
}
