import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MissionCurrent, MissionProgressRecord, MissionUsage } from "./types.ts";

export function missionRoot(cwd: string): string {
	return join(cwd, ".missions");
}

export function missionDir(cwd: string, slug: string): string {
	return join(missionRoot(cwd), slug);
}

export async function initializeMissionArtifacts(cwd: string, mission: MissionCurrent, usage?: MissionUsage): Promise<void> {
	await mkdir(mission.artifactDir, { recursive: true });
	await Promise.all([
		writeFile(join(mission.artifactDir, "mission.md"), formatMissionMarkdown(mission, usage), "utf8"),
		writeFile(join(mission.artifactDir, "plan.md"), formatPlanMarkdown(mission), "utf8"),
		writeFile(join(mission.artifactDir, "decisions.md"), formatDecisionsMarkdown(mission), "utf8"),
		writeFile(join(mission.artifactDir, "audit.md"), formatAuditMarkdown(mission), "utf8"),
		writeFile(join(mission.artifactDir, "log.md"), formatProgressLogMarkdown(mission, []), "utf8"),
	]);
}

export async function updateMissionSummaryArtifact(mission: MissionCurrent, usage?: MissionUsage): Promise<void> {
	await mkdir(mission.artifactDir, { recursive: true });
	await writeFile(join(mission.artifactDir, "mission.md"), formatMissionMarkdown(mission, usage), "utf8");
}

export async function writeMissionProgressArtifacts(mission: MissionCurrent, progress: MissionProgressRecord[], usage?: MissionUsage): Promise<void> {
	await mkdir(mission.artifactDir, { recursive: true });
	await Promise.all([
		writeFile(join(mission.artifactDir, "log.md"), formatProgressLogMarkdown(mission, progress), "utf8"),
		writeFile(join(mission.artifactDir, "mission.md"), formatMissionMarkdown(mission, usage, progress), "utf8"),
	]);
}

export async function writeCompletionAudit(mission: MissionCurrent, summary: string | undefined, audit: Array<{ requirement: string; evidence: string }> | undefined, usage: MissionUsage): Promise<void> {
	await mkdir(mission.artifactDir, { recursive: true });
	const lines = [
		`# Completion Audit: ${mission.title}`,
		"",
		`Status: ${mission.status}`,
		`Completed: ${new Date(mission.updatedAt).toISOString()}`,
		`Usage: ${usage.totalTokens} tokens, $${usage.totalCostUsd.toFixed(4)}`,
		"",
		"## Summary",
		"",
		summary?.trim() || "(No summary provided.)",
		"",
		"## Requirement Evidence",
		"",
	];
	if (audit?.length) {
		for (const item of audit) lines.push(`- ${item.requirement}: ${item.evidence}`);
	} else {
		lines.push("- (Model did not provide a structured audit. See final conversation turn for evidence.)");
	}
	lines.push("");
	await writeFile(join(mission.artifactDir, "audit.md"), lines.join("\n"), "utf8");
}

function formatMissionMarkdown(mission: MissionCurrent, usage?: MissionUsage, progress: MissionProgressRecord[] = []): string {
	const budget = [
		mission.tokenBudget ? `Token budget: ${mission.tokenBudget}` : "Token budget: unbounded",
		mission.costBudgetUsd ? `Cost budget: $${mission.costBudgetUsd}` : "Cost budget: unbounded",
	].join("\n");
	const usageText = usage ? [`Tokens used: ${usage.totalTokens}`, `Cost used: $${usage.totalCostUsd.toFixed(4)}`].join("\n") : "Usage: not accounted yet";
	const latest = progress.at(-1);
	return [
		`# Mission: ${mission.title}`,
		"",
		`Mission ID: ${mission.missionId}`,
		`Status: ${mission.status}`,
		`Chain: ${mission.chain}@${mission.chainBranch}`,
		`Artifacts: ${mission.artifactDir}`,
		`Created: ${new Date(mission.createdAt).toISOString()}`,
		`Updated: ${new Date(mission.updatedAt).toISOString()}`,
		"",
		"## Budget",
		budget,
		"",
		"## Usage",
		usageText,
		"",
		"## Objective",
		mission.objective,
		"",
		"## Requirements",
		...(mission.requirements.length ? mission.requirements.map((item) => `- ${item}`) : ["- (not decomposed)"]),
		"",
		"## Current Reason",
		mission.lastReason ?? "(none)",
		"",
		"## Latest Progress",
		latest ? `${new Date(latest.at).toISOString()} — ${latest.summary}` : "(none recorded)",
		"",
	].join("\n");
}

function formatPlanMarkdown(mission: MissionCurrent): string {
	return [
		`# Plan: ${mission.title}`,
		"", 
		"This file is initialized once. Prefer `mission_progress` for durable progress; avoid manually editing plan/audit/decisions every slice unless doing a checkpoint or final audit.",
		"",
		"## Requirements",
		"",
		...(mission.requirements.length ? mission.requirements.map((item) => `- [ ] ${item}`) : ["- [ ] (not decomposed)"]),
		"",
		"## Operating Checklist",
		"",
		"- [ ] Define the smallest concrete next deliverable.",
		"- [ ] Gather real repo/session evidence before changing behavior.",
		"- [ ] Execute one bounded, verifiable work slice.",
		"- [ ] Validate with commands, artifact inspection, or other concrete evidence.",
		"- [ ] Record durable progress with `mission_progress` when summary/evidence/remaining work changes.",
		"- [ ] Save a chain link only at meaningful checkpoints, handoffs, or final cleanup.",
		"",
		"## Completion Gate",
		"",
		"Before completing, update `audit.md` with requirement-to-evidence mapping and confirm no required work remains.",
		"",
	].join("\n");
}

function formatDecisionsMarkdown(mission: MissionCurrent): string {
	return [`# Decisions: ${mission.title}`, "", `Objective: ${mission.objective}`, "", "Append important architecture/product decisions here.", ""].join("\n");
}

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function formatAuditMarkdown(mission: MissionCurrent): string {
	return [
		`# Completion Audit: ${mission.title}`,
		"",
		"Fill this when the mission is complete. Do not call `mission_complete` until every requirement has evidence.",
		"",
		"Use `mission_search`/`log.md` as supporting notes, then write a concrete requirement-to-evidence audit at completion time.",
		"",
		"## Requirements to Evidence",
		"",
		"| Requirement | Evidence | Status |",
		"| --- | --- | --- |",
		...(mission.requirements.length ? mission.requirements.map((item) => `| ${escapeTableCell(item)} |  | pending |`) : ["| Restate objective as concrete deliverables |  | pending |"]),
		"| Validate implementation or task output with real commands/artifacts |  | pending |",
		"| Save durable handoff when useful |  | pending |",
		"",
	].join("\n");
}

function formatProgressLogMarkdown(mission: MissionCurrent, progress: MissionProgressRecord[]): string {
	const lines = [
		`# Mission Log: ${mission.title}`,
		"",
		"Append-only generated view of `mission_progress` records. Search this file with `mission_search`.",
		"",
	];
	if (progress.length === 0) {
		lines.push("(no progress recorded yet)", "");
		return lines.join("\n");
	}
	for (const item of progress) {
		lines.push(`## ${new Date(item.at).toISOString()}${item.checkpoint ? " checkpoint" : ""}`, "", item.summary, "");
		if (item.evidence.length) lines.push("Evidence:", ...item.evidence.map((value) => `- ${value}`), "");
		if (item.validation.length) lines.push("Validation:", ...item.validation.map((value) => `- ${value}`), "");
		if (item.remaining.length) lines.push("Remaining:", ...item.remaining.map((value) => `- ${value}`), "");
	}
	return lines.join("\n");
}
