import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { RuntimeError } from "../errors.ts";
import type { HerdrAgentStatus } from "../schemas/herdr.ts";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from "../schemas/json.ts";
import { type HostedAgentTarget, type HostedTarget, isHeld } from "../schemas/state.ts";
import { HostedStateStore } from "./state.ts";

/** What `herdr agent get` reports about one live agent: where it runs, the tab that owns it, and how busy it is. */
export interface HostedLiveAgent {
	name?: string;
	cwd: string;
	tabId?: string;
	workspaceId?: string;
	sessionPath?: string;
	agentStatus?: HerdrAgentStatus;
}

export interface HostedHostVerifier {
	/** Resolves `herdr agent get <name>` for one exact Herdr agent name. */
	getAgent(agentName: string): Promise<HostedLiveAgent>;
	/** Injects one short prompt into a native tab; a failure means undelivered, never that the agent acted. */
	promptAgent?(agentName: string, text: string): Promise<void>;
	closeTarget?(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged">;
}

export function heldByTarget(store: HostedStateStore, target: HostedAgentTarget): boolean {
	const participant = store.read().participants[target.participantKey];
	return isHeld(participant?.state)
		&& participant.holderTargetKey === target.targetKey
		&& participant.generation === target.holderGeneration;
}

export function assertAgentInProject(agent: HostedLiveAgent, target: HostedAgentTarget): void {
	if (agent.name !== target.agentName) {
		throw new RuntimeError("identity_mismatch", "Herdr agent name does not match its Runtime target.");
	}
	let hostCwd: string;
	try { hostCwd = canonicalDirectory(agent.cwd, "Herdr cwd"); }
	catch { throw new RuntimeError("identity_mismatch", "Herdr agent cwd is unavailable or not canonical."); }
	if (hostCwd !== (target.worktreePath ?? target.projectRoot)) {
		throw new RuntimeError("identity_mismatch", "Herdr agent cwd does not match its authorized project or worktree root.");
	}
}

export function canonicalDirectory(path: string, name: string): string {
	try {
		const canonical = realpathSync(path);
		if (!lstatSync(canonical).isDirectory()) throw new Error();
		return canonical;
	} catch {
		throw new RuntimeError("invalid_request", `${name} must be an existing directory.`);
	}
}

export function canonicalFile(path: string, name: string): string {
	try {
		const canonical = realpathSync(path);
		if (!lstatSync(canonical).isFile()) throw new Error();
		return canonical;
	} catch {
		throw new RuntimeError("invalid_request", `${name} must be an existing regular file.`);
	}
}

/** A Pi target is live exactly while its session file still carries its session ID and project cwd. */
export function verifyPiSessionHeader(path: string, expectedId: string, expectedCwd: string): void {
	const buffer = Buffer.alloc(64 * 1024);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, "r");
		const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
		const newline = buffer.subarray(0, bytes).indexOf(0x0a);
		if (newline < 0) throw new Error("missing bounded header");
		const header = strictObject(JSON.parse(buffer.subarray(0, newline).toString("utf8")), "Pi session header");
		if (header.type !== "session" || header.id !== expectedId) throw new Error("session identity mismatch");
		if (canonicalDirectory(text(header.cwd), "Pi session cwd") !== expectedCwd) throw new Error("session identity mismatch");
	} catch {
		throw new RuntimeError("invalid_request", "Pi session file header does not match the supplied session ID.");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

export function strictObject(value: JsonValue | undefined, name: string): JsonObject {
	if (!isJsonObject(value)) throw new Error(`${name} must be an object.`);
	return value;
}

export function text(value: JsonValue | undefined): string {
	if (!isJsonString(value) || value.length === 0) throw new Error("expected non-empty text");
	return value;
}
