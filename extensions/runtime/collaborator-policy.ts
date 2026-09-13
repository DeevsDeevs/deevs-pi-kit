import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CustomToolCallEvent } from "@earendil-works/pi-coding-agent";
import { findAgent, loadBuiltinAgents } from "../subagents/agents.ts";
import type { AgentDefinition } from "../subagents/catalog-types.ts";
import { HostedRuntimeClientError } from "./client.ts";
import type { HostedCollaboratorDriver, HostedCollaboratorProfile } from "./hosted-types.ts";
import { toolDefinitions } from "./mcp/tools.ts";
import { isStringValue } from "./responses.ts";
import { COLLABORATOR_MODEL, COLLABORATOR_NAME, type CollaboratorPersona } from "./session-record.ts";

const COLLABORATOR_METADATA_TOOLS = ["collaborator_list", ...toolDefinitions.map(tool => tool.name), "chain_save", "chain_load", "chain_context"] as const;
export const READ_ONLY_COLLABORATOR_TOOLS = ["read", "grep", "find", "ls", "safe_diff", ...COLLABORATOR_METADATA_TOOLS] as const;
export const WORKSPACE_WRITE_COLLABORATOR_TOOLS = [...READ_ONLY_COLLABORATOR_TOOLS, "edit", "write"] as const;
const COLLABORATOR_PERSONAS = loadBuiltinAgents();
const PI_COLLABORATOR_MODEL = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/:-]*$/;
const FILE_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write"]);
const READ_ONLY_PERSONA_TOOLS = new Set(["safe_read", "safe_list", "safe_search", "safe_diff"]);
const WORKSPACE_WRITE_PERSONA_TOOLS = new Set([...READ_ONLY_PERSONA_TOOLS, "edit", "write"]);
const OPTIONAL_COLLABORATOR_PERSONA_TOOLS = new Set(["review_report"]);

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
	const requestedModel = collaboratorModel(candidate.model);
	assertUnambiguousCollaboratorModel(driver, requestedModel);
	const requestedProfile = collaboratorProfile(candidate.profile);
	if (!candidate.persona) {
		const profile = requestedProfile ?? (driver === "pi" ? undefined : "read-only");
		const result: ResolvedCollaboratorCandidate = { participantId, driver };
		if (requestedModel) result.model = requestedModel;
		if (profile) result.profile = profile;
		return result;
	}
	const profile = requestedProfile ?? "read-only";
	const resolved = resolvePersona(candidate.persona, profile, driver);
	const model = requestedModel ?? (driver === "pi" ? collaboratorModel(resolved.definition.model) : undefined);
	assertUnambiguousCollaboratorModel(driver, model);
	const result: ResolvedCollaboratorCandidate = { participantId, driver, profile, persona: resolved.persona };
	if (model) result.model = model;
	return result;
}

interface ResolvedPersona {
	persona: CollaboratorPersona;
	definition: AgentDefinition;
}

function resolvePersona(requested: string, profile: HostedCollaboratorProfile, driver: HostedCollaboratorDriver): ResolvedPersona {
	const personaName = collaboratorName(requested, "persona");
	const definition = findAgent(COLLABORATOR_PERSONAS, personaName);
	if (!definition || definition.disabled) throw new HostedRuntimeClientError("not_found", `Unknown or disabled collaborator persona ${personaName}.`);
	assertPersonaCompatible(definition, profile, driver);
	const prompt = definition.body.trim();
	if (!prompt || Buffer.byteLength(prompt) > 32 * 1024) {
		throw new HostedRuntimeClientError("invalid_request", `Collaborator persona ${personaName} has an invalid prompt.`);
	}
	return { definition, persona: { name: definition.name, prompt, promptHash: createHash("sha256").update(prompt).digest("hex") } };
}

function assertPersonaCompatible(persona: AgentDefinition, profile: HostedCollaboratorProfile, driver: HostedCollaboratorDriver): void {
	if (driver !== "pi" && persona.tools.includes("safe_diff")) {
		throw new HostedRuntimeClientError("conflict", `Native collaborator persona ${persona.name} requires unsupported safe_diff tooling.`);
	}
	const supported = profile === "read-only" ? READ_ONLY_PERSONA_TOOLS : WORKSPACE_WRITE_PERSONA_TOOLS;
	const incompatible = persona.tools.filter((tool) => !supported.has(tool) && !OPTIONAL_COLLABORATOR_PERSONA_TOOLS.has(tool));
	if (incompatible.length > 0) {
		throw new HostedRuntimeClientError("conflict", `Collaborator persona ${persona.name} requires unsupported ${incompatible.join(", ")} tooling.`);
	}
}

export function usesNativeUserConfiguration(candidate: ResolvedCollaboratorCandidate): boolean {
	return candidate.driver !== "pi" && candidate.profile === "workspace-write";
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
	const allowed: readonly string[] = profile === "read-only" ? READ_ONLY_COLLABORATOR_TOOLS : WORKSPACE_WRITE_COLLABORATOR_TOOLS;
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
		return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
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
	if (!value || !COLLABORATOR_NAME.test(value)) throw new HostedRuntimeClientError("invalid_request", `${name} must match ${COLLABORATOR_NAME}.`);
	return value;
}

function collaboratorDriver(value: HostedCollaboratorDriver | undefined): HostedCollaboratorDriver {
	if (value === undefined || value === "pi") return "pi";
	if (value === "claude-code" || value === "codex") return value;
	throw new HostedRuntimeClientError("invalid_request", "driver must be pi, claude-code, or codex.");
}

function collaboratorModel(value: string | undefined): string | undefined {
	if (value !== undefined && !COLLABORATOR_MODEL.test(value)) {
		throw new HostedRuntimeClientError("invalid_request", `model must match ${COLLABORATOR_MODEL}.`);
	}
	return value;
}

function assertUnambiguousCollaboratorModel(driver: HostedCollaboratorDriver, model: string | undefined): void {
	if (driver !== "pi" || model === undefined || PI_COLLABORATOR_MODEL.test(model)) return;
	throw new HostedRuntimeClientError("invalid_request", "Explicit Pi collaborator models must be provider-qualified, for example openai-codex/gpt-5.6-sol.");
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
