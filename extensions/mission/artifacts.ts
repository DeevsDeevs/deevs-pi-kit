import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MissionCurrent, MissionProgressRecord, MissionUsage } from "./types.ts";

export function missionRoot(cwd: string): string {
	return join(cwd, ".missions");
}

export function missionDir(cwd: string, slug: string): string {
	return join(missionRoot(cwd), slug);
}

export async function initializeMissionArtifacts(mission: MissionCurrent, usage?: MissionUsage): Promise<void> {
	await prepareArtifactDirectory(mission.artifactDir);
	await Promise.all([
		writeArtifactFile(join(mission.artifactDir, "mission.md"), formatMissionMarkdown(mission, usage)),
		writeArtifactFile(join(mission.artifactDir, "log.md"), formatProgressLogMarkdown(mission, [])),
	]);
}

export async function updateMissionSummaryArtifact(mission: MissionCurrent, usage?: MissionUsage): Promise<void> {
	await prepareArtifactDirectory(mission.artifactDir);
	await writeArtifactFile(join(mission.artifactDir, "mission.md"), formatMissionMarkdown(mission, usage));
}

export async function writeMissionProgressArtifacts(mission: MissionCurrent, progress: MissionProgressRecord[], usage?: MissionUsage): Promise<void> {
	await prepareArtifactDirectory(mission.artifactDir);
	await Promise.all([
		writeArtifactFile(join(mission.artifactDir, "log.md"), formatProgressLogMarkdown(mission, progress)),
		writeArtifactFile(join(mission.artifactDir, "mission.md"), formatMissionMarkdown(mission, usage, progress)),
	]);
}

export async function writeCompletionAudit(mission: MissionCurrent, summary: string | undefined, audit: Array<{ requirementIndex: number; evidence: string }> | undefined, usage: MissionUsage, progress: MissionProgressRecord[] = []): Promise<void> {
	await prepareArtifactDirectory(mission.artifactDir);
	const lines = [
		formatMissionMarkdown(mission, usage, progress).trimEnd(),
		"",
		"## Completion Audit",
		"",
		`Completed: ${new Date(mission.updatedAt).toISOString()}`,
		"",
		"### Summary",
		"",
		summary?.trim() || "(No summary provided.)",
		"",
		"### Requirement Evidence",
		"",
	];
	if (audit?.length) for (const item of audit) lines.push(`- [${item.requirementIndex}] ${mission.requirements[item.requirementIndex] ?? "(unknown requirement)"}: ${item.evidence.trim()}`);
	else lines.push("- (Model did not provide a structured audit. See final conversation turn for evidence.)");
	lines.push("");
	await writeArtifactFile(join(mission.artifactDir, "mission.md"), lines.join("\n"));
}

async function prepareArtifactDirectory(artifactDir: string): Promise<void> {
	await ensureDirectory(dirname(artifactDir));
	await ensureDirectory(artifactDir);
}

async function ensureDirectory(directory: string): Promise<void> {
	try {
		await mkdir(directory);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const info = await lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Mission artifact path is not a real directory: ${directory}`);
}

async function writeArtifactFile(filePath: string, content: string): Promise<void> {
	let existing: Awaited<ReturnType<typeof lstat>> | undefined;
	try {
		existing = await lstat(filePath);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	if (existing?.isSymbolicLink()) throw new Error(`Mission artifact path is a symlink: ${filePath}`);
	const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
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
		"> Generated projection. Canonical machine state is stored in the workspace `.missions/.state/` registry.",
		"",
		`Mission ID: ${mission.missionId}`,
		`Status: ${mission.status}`,
		`Chain: ${mission.chain}@${mission.chainBranch}`,
		`Artifacts: .missions/${mission.slug}`,
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
		...(mission.requirements.length ? mission.requirements.map((item, index) => `- [${index}] ${item}`) : ["- (not decomposed)"]),
		"",
		"## Owned Paths",
		...(mission.paths.length ? mission.paths.map((item) => `- ${item}`) : ["- (not specified)"]),
		"",
		"## Current Reason",
		mission.lastReason ?? "(none)",
		"",
		"## Latest Progress",
		latest ? `${new Date(latest.at).toISOString()} — ${latest.summary}` : "(none recorded)",
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
		if (item.validation.length) lines.push("Validation:", ...item.validation.map((value) => `- ${value.command} → ${value.exitCode}${value.summary ? ` · ${value.summary}` : ""}${value.artifact ? ` · ${value.artifact}` : ""}`), "");
		if (item.remaining.length) lines.push("Remaining:", ...item.remaining.map((value) => `- ${value}`), "");
	}
	return lines.join("\n");
}
