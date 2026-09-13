import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HostedRuntimeClientError } from "./client.ts";
import { strictObject, type SerializedObject } from "./responses.ts";

/** Accepts the Claude trust dialog for one exact guarded read-only workspace, never a broader permission. */
export function markClaudeWorkspaceTrusted(cwd: string, configPath = join(homedir(), ".claude.json")): void {
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 3; attempt++) {
		const original = existsSync(configPath) ? readClaudeTrustStore(configPath) : undefined;
		const config = parseClaudeTrustStore(original);
		const projects = config.projects === undefined ? {} : strictObject(config.projects, "Claude workspace trust projects");
		const existing = projects[cwd] === undefined ? undefined : strictObject(projects[cwd], "Claude workspace trust entry");
		if (existing?.hasTrustDialogAccepted === true) return;
		const next = { ...config, projects: { ...projects, [cwd]: { ...existing, hasTrustDialogAccepted: true } } };
		const temporary = join(dirname(configPath), `.${basename(configPath)}.${process.pid}.${randomUUID()}.tmp`);
		try {
			writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
			const current = existsSync(configPath) ? readClaudeTrustStore(configPath) : undefined;
			if (current !== original) continue;
			renameSync(temporary, configPath);
			return;
		} finally {
			if (existsSync(temporary)) rmSync(temporary, { force: true });
		}
	}
	throw new HostedRuntimeClientError("conflict", "Claude workspace trust store changed concurrently; retry launch.");
}

function parseClaudeTrustStore(original: string | undefined): SerializedObject {
	if (original === undefined) return {};
	try {
		return strictObject(JSON.parse(original), "Claude workspace trust store");
	} catch {
		throw new HostedRuntimeClientError("host_unavailable", "Claude workspace trust store is malformed.");
	}
}

function readClaudeTrustStore(configPath: string): string {
	const metadata = lstatSync(configPath);
	if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) {
		throw new HostedRuntimeClientError("host_unavailable", "Claude workspace trust store is unavailable.");
	}
	return readFileSync(configPath, "utf8");
}
