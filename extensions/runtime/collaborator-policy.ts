import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import { resolveModel, type ModelContext } from "../shared/models.ts";
import { findAgentType } from "../subagents/definitions.ts";
import { HostedRuntimeClientError } from "./client.ts";
import { isNodeError } from "./errors.ts";
import { collaboratorProfileTools, DRIVERS } from "./drivers.ts";
import { type HostedCollaboratorDriver, type HostedCollaboratorProfile, isWriter } from "./schemas/state.ts";
import { isJsonString, type JsonValue } from "./schemas/json.ts";
import { PARTICIPANT_NAME } from "./schemas/common.ts";
import type { CollaboratorPersona, StartedCollaborator } from "./schemas/session.ts";

const WRITE_TOOLS = new Set(["edit", "write"]);

export type CollaboratorCandidate = Omit<StartedCollaborator, "tabId">;

export interface ResolvedCollaboratorCandidate {
	participantId: string;
	driver: HostedCollaboratorDriver;
	model?: string;
	profile: HostedCollaboratorProfile;
	persona?: CollaboratorPersona;
	repo?: string;
	/** Resolved by the start path once the project root is known; absent when the collaborator works at the root. */
	repoRoot?: string;
	/** The Claude or Codex session a stood-down native collaborator resumes. */
	resume?: string;
}

export interface CollaboratorToolBlock {
	block: true;
	reason: string;
}

/** The harness comes from the model spec (§3.2): `claude:` runs Claude Code, `codex:` runs Codex, anything else Pi. */
export function resolveCollaboratorCandidate(candidate: CollaboratorCandidate, models: ModelContext): ResolvedCollaboratorCandidate {
	const participantId = collaboratorName(candidate.participantId, "participant ID");
	const persona = candidate.persona ? resolvePersona(candidate.persona) : undefined;
	let resolved;
	try {
		resolved = resolveModel(candidate.model ?? persona?.model, models);
	} catch (error) {
		throw new HostedRuntimeClientError("invalid_request", error instanceof Error ? error.message : String(error));
	}
	const driver: HostedCollaboratorDriver = resolved.harness === "claude" ? "claude-code" : resolved.harness;
	const model = resolved.harness === "pi" ? `${resolved.model.provider}/${resolved.model.id}` : resolved.model;
	const result: ResolvedCollaboratorCandidate = { participantId, driver, model, profile: candidate.profile ?? "read-only" };
	if (persona) result.persona = persona.persona;
	if (candidate.repo !== undefined) result.repo = candidate.repo;
	if (candidate.nativeSession && driver !== "pi") result.resume = candidate.nativeSession;
	return result;
}

interface ResolvedPersona {
	persona: CollaboratorPersona;
	model?: string;
}

/** A persona is one trusted built-in prompt, named as for Agent; its tool allowlist is the launched profile's, not the persona's. */
function resolvePersona(requested: string): ResolvedPersona {
	let type;
	try {
		type = findAgentType(requested);
	} catch (error) {
		throw new HostedRuntimeClientError("not_found", error instanceof Error ? error.message : String(error));
	}
	const prompt = type.prompt.trim();
	if (!prompt || Buffer.byteLength(prompt) > 32 * 1024) {
		throw new HostedRuntimeClientError("invalid_request", `Collaborator persona ${type.name} has an invalid prompt.`);
	}
	const persona: CollaboratorPersona = {
		name: type.name,
		prompt,
		promptHash: createHash("sha256").update(prompt).digest("hex"),
	};
	return type.model ? { persona, model: type.model } : { persona };
}

function usesNativeUserConfiguration(candidate: ResolvedCollaboratorCandidate): boolean {
	if (!DRIVERS[candidate.driver].bind) return false;
	return isWriter(candidate.profile);
}

export function collaboratorConfiguration(candidate: ResolvedCollaboratorCandidate): string {
	const configuration = [
		`driver ${candidate.driver}`,
		candidate.model ? `model ${candidate.model}` : `model ${candidate.driver} default`,
		candidate.persona ? `persona ${candidate.persona.name}` : "persona none",
		`profile ${candidate.profile}`,
		...(candidate.repo ? [`repo ${candidate.repo}`] : []),
	].join(", ");
	if (!usesNativeUserConfiguration(candidate)) return configuration;
	return `${configuration}, normal native configuration/hooks/permissions (not an edit-only tool boundary)`;
}

/** Enforces one collaborator profile's tool allowlist and workspace confinement. */
export function collaboratorToolBlock(
	profile: HostedCollaboratorProfile,
	toolName: string,
	path: CustomToolCallEvent["input"]["path"],
	cwd: string,
): CollaboratorToolBlock | undefined {
	const allowed = collaboratorProfileTools(profile);
	if (!allowed.includes(toolName)) return { block: true, reason: `Collaborator profile ${profile} does not permit ${toolName}.` };
	if (!WRITE_TOOLS.has(toolName)) return undefined;
	if (collaboratorPathAllowed(cwd, path, toolName === "write")) return undefined;
	return { block: true, reason: `Collaborator profile ${profile} confines ${toolName} to the project workspace.` };
}

function collaboratorPathAllowed(cwd: string, value: CustomToolCallEvent["input"]["path"], allowMissing: boolean): boolean {
	// SAFETY: Tool input arrives untyped from the host; a non-string path is rejected on the next line.
	const path = value as JsonValue | undefined;
	if (path !== undefined && !isJsonString(path)) return false;
	try {
		const root = realpathSync(cwd);
		const requested = resolve(root, path ?? ".");
		const target = resolveExistingTarget(requested, allowMissing);
		if (target === undefined) return false;
		const relativePath = relative(root, target);
		if (relativePath === "") return true;
		return !isAbsolute(relativePath)
			&& relativePath !== ".."
			&& !relativePath.startsWith(`..${sep}`);
	} catch {
		return false;
	}
}

function resolveExistingTarget(requested: string, allowMissing: boolean): string | undefined {
	try { return realpathSync(requested); } catch {}
	if (!allowMissing) return undefined;
	try {
		lstatSync(requested);
		return undefined;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") return undefined;
	}
	return join(realpathSync(dirname(requested)), basename(requested));
}

export function collaboratorName(value: string | undefined, name: string): string {
	if (!value || !PARTICIPANT_NAME.test(value)) {
		throw new HostedRuntimeClientError("invalid_request", `${name} must match ${PARTICIPANT_NAME}.`);
	}
	return value;
}
