import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostedAgentTarget, HostedTarget } from "../hosted-types.ts";
import {
	canonicalFile,
	isParsedObject,
	RegistrationError,
	strictObject,
	stringValue,
	text,
	verifyPiSessionHeader,
	type HostedHostVerifier,
	type HostedLiveAgent,
	type ParsedValue,
} from "./identity.ts";

export class HerdrCliHostVerifier implements HostedHostVerifier {
	async getAgent(agentName: string): Promise<HostedLiveAgent> {
		const response = await runHerdr(["agent", "get", agentName]);
		return parseLiveAgent(strictObject(strictObject(response, "Herdr response").result, "Herdr result").agent);
	}

	async closeTarget(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged"> {
		switch (target.kind) {
			case "agent": return this.closeAgentTarget(target);
			case "pi": {
				const cwd = target.worktreePath ?? target.projectRoot;
				return this.closeCollaboratorTab(target.piSessionFile, target.piSessionId, cwd, runtimeRoot);
			}
			default: {
				const unreachable: never = target;
				throw new RegistrationError("not_found", `Unsupported runtime target ${JSON.stringify(unreachable)}.`);
			}
		}
	}

	/** Only a Pi collaborator Runtime itself started, proven by its own session file, is ever closed. */
	private async closeCollaboratorTab(
		piSessionFile: string,
		piSessionId: string,
		cwd: string,
		runtimeRoot: string,
	): Promise<"closed" | "already_absent" | "unmanaged"> {
		let sessionFile: string;
		try {
			sessionFile = canonicalFile(piSessionFile, "collaborator session file");
			if (dirname(sessionFile) !== realpathSync(join(runtimeRoot, "collaborator-sessions"))) return "unmanaged";
			verifyPiSessionHeader(sessionFile, piSessionId, cwd);
		} catch {
			return "unmanaged";
		}
		const find = async () => (await this.listAgents()).filter((agent) => agent.sessionPath === sessionFile);
		const matches = await find();
		const [agent] = matches;
		if (!agent) return "already_absent";
		if (matches.length !== 1) throw new RegistrationError("identity_mismatch", "Collaborator session is not unique in Herdr.");
		return this.closeTab(agent.tabId, agent.workspaceId, find);
	}

	private async closeAgentTarget(target: HostedAgentTarget): Promise<"closed" | "already_absent"> {
		const find = async () => (await this.listAgents()).filter((agent) => agent.name === target.agentName);
		if ((await find()).length === 0) return "already_absent";
		return this.closeTab(target.herdr.tabId, target.herdr.workspaceId, find);
	}

	/** A Runtime-owned tab holds exactly its collaborator pane; anything else is the operator's. */
	private async closeTab(
		tabId: string | undefined,
		workspaceId: string | undefined,
		find: () => Promise<HostedLiveAgent[]>,
	): Promise<"closed" | "already_absent"> {
		if (!tabId || !workspaceId) throw new RegistrationError("identity_mismatch", "Collaborator has no exact Herdr tab identity.");
		const response = await runHerdr(["tab", "get", tabId]);
		const tab = strictObject(strictObject(strictObject(response, "Herdr response").result, "Herdr result").tab, "Herdr tab");
		if (tab.tab_id !== tabId || tab.workspace_id !== workspaceId || tab.pane_count !== 1) {
			throw new RegistrationError("identity_mismatch", "Collaborator tab identity changed before stop.");
		}
		try {
			await runHerdr(["tab", "close", tabId]);
			return "closed";
		} catch (error) {
			if ((await find()).length === 0) return "already_absent";
			throw error;
		}
	}

	private async listAgents(): Promise<HostedLiveAgent[]> {
		const response = await runHerdr(["agent", "list"]);
		const agents = strictObject(strictObject(response, "Herdr response").result, "Herdr result").agents;
		if (!Array.isArray(agents)) throw new RegistrationError("host_unavailable", "Herdr agent list is malformed.");
		return agents.map(parseLiveAgent);
	}
}

function parseLiveAgent(value: ParsedValue | undefined): HostedLiveAgent {
	try {
		const agent = strictObject(value, "Herdr agent");
		const session = agent.agent_session === undefined ? undefined : strictObject(agent.agent_session, "Herdr agent session");
		const result: HostedLiveAgent = { cwd: text(agent.cwd) };
		const name = stringValue(agent.name);
		const tabId = stringValue(agent.tab_id);
		const workspaceId = stringValue(agent.workspace_id);
		if (name !== undefined) result.name = name;
		if (tabId !== undefined) result.tabId = tabId;
		if (workspaceId !== undefined) result.workspaceId = workspaceId;
		const sessionPath = session?.kind === "path" ? canonicalPath(text(session.value)) : undefined;
		if (sessionPath !== undefined) result.sessionPath = sessionPath;
		return result;
	} catch (error) {
		if (error instanceof RegistrationError) throw error;
		throw new RegistrationError("host_unavailable", "Herdr returned malformed agent identity.");
	}
}

function canonicalPath(path: string): string | undefined {
	try { return realpathSync(path); } catch { return undefined; }
}

function runHerdr(args: string[]): Promise<ParsedValue> {
	return new Promise((resolve, reject) => {
		execFile("herdr", args, { timeout: 2_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) {
				reject(herdrQueryFailure(stdout));
				return;
			}
			try { resolve(JSON.parse(stdout)); } catch { reject(new RegistrationError("host_unavailable", "Herdr returned invalid JSON.")); }
		});
	});
}

/** A structured Herdr error means Herdr answered and the agent is absent; anything else is an unanswered query. */
function herdrQueryFailure(stdout: string): RegistrationError {
	if (stdout.length > 8192) return new RegistrationError("host_unavailable", "Herdr identity query failed.");
	try {
		// SAFETY: Herdr CLI output is untrusted JSON, narrowed to an error object before it is trusted.
		const response = JSON.parse(stdout) as ParsedValue;
		if (!isParsedObject(response) || !isParsedObject(response.error)) throw new Error("unstructured output");
		return new RegistrationError("identity_mismatch", "Herdr reports no such agent.");
	} catch {
		return new RegistrationError("host_unavailable", "Herdr identity query failed.");
	}
}
