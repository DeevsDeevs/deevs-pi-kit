import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import { findAgent, loadBuiltinAgents } from "../subagents/agents.ts";
import { HostedRuntimeClientError } from "./client.ts";
import { collaboratorProfileTools, DRIVERS } from "./drivers.ts";
import type { HostedCollaboratorDriver, HostedCollaboratorProfile } from "./hosted-types.ts";
import { isStringValue } from "./responses.ts";
import { COLLABORATOR_MODEL, COLLABORATOR_NAME, type CollaboratorPersona } from "./session-record.ts";

const PATH_SEPARATOR = process.platform === "win32" ? "\\" : "/";
const COLLABORATOR_PERSONAS = loadBuiltinAgents();
const PI_COLLABORATOR_MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/:-]*$/;
const FILE_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);

export interface CollaboratorCandidate {
	participantId: string;
	driver?: HostedCollaboratorDriver;
	model?: string;
	persona?: string;
	profile?: HostedCollaboratorProfile;
}

export interface ResolvedCollaboratorCandidate {
	participantId: string;
	driver: HostedCollaboratorDriver;
	model?: string;
	profile?: HostedCollaboratorProfile;
	persona?: CollaboratorPersona;
}

export interface CollaboratorToolBlock {
	block: true;
	reason: string;
}

export function resolveCollaboratorCandidate(candidate: CollaboratorCandidate): ResolvedCollaboratorCandidate {
	const participantId = collaboratorName(candidate.participantId, "participant ID");
	const driver = collaboratorDriver(candidate.driver);
	const spec = DRIVERS[driver];
	const requestedModel = collaboratorModel(candidate.model);
	const requestedProfile = collaboratorProfile(candidate.profile);
	const persona = candidate.persona ? resolvePersona(candidate.persona) : undefined;
	const profile = requestedProfile ?? (persona ? "read-only" : spec.defaultProfile);
	const model = requestedModel ?? (spec.personaModel ? collaboratorModel(persona?.model) : undefined);
	assertUnambiguousCollaboratorModel(spec.qualifiedModel, model);
	const resolved: ResolvedCollaboratorCandidate = { participantId, driver };
	if (model) resolved.model = model;
	if (profile) resolved.profile = profile;
	if (persona) resolved.persona = persona.persona;
	return resolved;
}

interface ResolvedPersona {
	persona: CollaboratorPersona;
	model?: string;
}

/** A persona is one trusted built-in prompt; its tool allowlist is the launched profile's, not the persona's. */
function resolvePersona(requested: string): ResolvedPersona {
	const personaName = collaboratorName(requested, "persona");
	const definition = findAgent(COLLABORATOR_PERSONAS, personaName);
	if (!definition || definition.disabled) {
		throw new HostedRuntimeClientError("not_found", `Unknown or disabled collaborator persona ${personaName}.`);
	}
	const prompt = definition.body.trim();
	if (!prompt || Buffer.byteLength(prompt) > 32 * 1024) {
		throw new HostedRuntimeClientError("invalid_request", `Collaborator persona ${personaName} has an invalid prompt.`);
	}
	const persona: CollaboratorPersona = {
		name: definition.name,
		prompt,
		promptHash: createHash("sha256").update(prompt).digest("hex"),
	};
	return definition.model ? { persona, model: definition.model } : { persona };
}

function usesNativeUserConfiguration(candidate: ResolvedCollaboratorCandidate): boolean {
	if (!DRIVERS[candidate.driver].bind) return false;
	return candidate.profile === "workspace-write";
}

export function collaboratorConfiguration(candidate: ResolvedCollaboratorCandidate): string {
	const configuration = [
		`driver ${candidate.driver}`,
		candidate.model ? `model ${candidate.model}` : `model ${candidate.driver} default`,
		candidate.persona ? `persona ${candidate.persona.name}` : "persona none",
		candidate.profile ? `profile ${candidate.profile}` : "profile none",
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
	if (!FILE_TOOLS.has(toolName)) return undefined;
	if (collaboratorPathAllowed(cwd, path, toolName === "write")) return undefined;
	return { block: true, reason: `Collaborator profile ${profile} confines ${toolName} to the project workspace.` };
}

function collaboratorPathAllowed(cwd: string, value: CustomToolCallEvent["input"]["path"], allowMissing: boolean): boolean {
	if (value !== undefined && !isStringValue(value)) return false;
	try {
		const root = realpathSync(cwd);
		const requested = resolve(root, value ?? ".");
		const target = resolveExistingTarget(requested, allowMissing);
		if (target === undefined) return false;
		const path = relative(root, target);
		if (path === "") return true;
		return !isAbsolute(path)
			&& path !== ".."
			&& !path.startsWith(`..${PATH_SEPARATOR}`);
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
	if (!value || !COLLABORATOR_NAME.test(value)) {
		throw new HostedRuntimeClientError("invalid_request", `${name} must match ${COLLABORATOR_NAME}.`);
	}
	return value;
}

function collaboratorDriver(value: HostedCollaboratorDriver | undefined): HostedCollaboratorDriver {
	if (value === undefined) return "pi";
	if (Object.hasOwn(DRIVERS, value)) return value;
	throw new HostedRuntimeClientError("invalid_request", "driver must be pi, claude-code, or codex.");
}

function collaboratorModel(value: string | undefined): string | undefined {
	if (value !== undefined && !COLLABORATOR_MODEL.test(value)) {
		throw new HostedRuntimeClientError("invalid_request", `model must match ${COLLABORATOR_MODEL}.`);
	}
	return value;
}

function assertUnambiguousCollaboratorModel(qualified: boolean, model: string | undefined): void {
	if (!qualified || model === undefined || PI_COLLABORATOR_MODEL.test(model)) return;
	const detail = "Explicit Pi collaborator models must be provider-qualified, for example openai-codex/gpt-5.6-sol.";
	throw new HostedRuntimeClientError("invalid_request", detail);
}

function collaboratorProfile(value: HostedCollaboratorProfile | undefined): HostedCollaboratorProfile | undefined {
	if (value !== undefined && value !== "read-only" && value !== "workspace-write") {
		throw new HostedRuntimeClientError("invalid_request", "profile must be read-only or workspace-write.");
	}
	return value;
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
	return cause instanceof Error && "code" in cause;
}
