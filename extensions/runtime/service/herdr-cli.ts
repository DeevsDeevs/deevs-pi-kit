import { execFile } from "node:child_process";
import type { Static, TSchema } from "typebox";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { RuntimeError } from "../errors.ts";
import { isJsonObject, type JsonObject } from "../schemas/json.ts";
import type { HostedAgentTarget, HostedTarget } from "../schemas/state.ts";
import {
	decodeHerdr,
	herdrResult,
	HerdrLiveAgentListSchema,
	HerdrLiveAgentResultSchema,
	HerdrTabResultSchema,
	type HerdrLiveAgent,
} from "../schemas/herdr.ts";
import type { HerdrAgentStatus } from "../schemas/herdr.ts";

/** What `herdr agent get` reports about one live agent: where it runs, the tab that owns it, and how busy it is. */
export interface HostedLiveAgent {
	name?: string;
	cwd: string;
	tabId?: string;
	workspaceId?: string;
	sessionPath?: string;
	agentStatus?: HerdrAgentStatus;
	/** Herdr counts the agent's status changes; a prompted tab that took a turn has moved it. */
	stateSeq?: number;
	/** False while the agent's TUI cannot take typed input yet, such as during its startup. */
	ready?: boolean;
}

export interface HostedHostVerifier {
	/** Resolves `herdr agent get <name>` for one exact Herdr agent name. */
	getAgent(agentName: string): Promise<HostedLiveAgent>;
	/** Types one prompt into a native tab; a failure means undelivered, never that the agent acted. */
	promptAgent?(agentName: string, text: string): Promise<void>;
	closeTarget?(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged">;
}

/** Every heartbeat and sweep asks after the same few agents; one answer per agent per second is fresh enough. */
const AGENT_CACHE_MS = 1_000;

export class HerdrCliHostVerifier implements HostedHostVerifier {
	private readonly agents = new Map<string, { at: number; live: Promise<HostedLiveAgent> }>();

	getAgent(agentName: string): Promise<HostedLiveAgent> {
		const cached = this.agents.get(agentName);
		if (cached && Date.now() - cached.at < AGENT_CACHE_MS) return cached.live;
		const live = runHerdr(["agent", "get", agentName]).then((result) => liveAgent(decodeAgents(HerdrLiveAgentResultSchema, result).agent));
		this.agents.set(agentName, { at: Date.now(), live });
		live.catch(() => this.agents.delete(agentName));
		return live;
	}

	/** The one native wake: Herdr's own prompt API, with no --wait and no proof that the agent acted on it. */
	async promptAgent(agentName: string, text: string): Promise<void> {
		await execHerdr(["agent", "prompt", agentName, text]);
	}

	async closeTarget(target: HostedTarget, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged"> {
		switch (target.kind) {
			case "agent": return this.closeAgentTarget(target);
			case "pi": return this.closeCollaboratorTab(target.piSessionFile, runtimeRoot);
			default: {
				const unreachable: never = target;
				throw new RuntimeError("not_found", `Unsupported runtime target ${JSON.stringify(unreachable)}.`);
			}
		}
	}

	/** Only a Pi collaborator Runtime itself started, in a session file of its own, is ever closed. */
	private async closeCollaboratorTab(piSessionFile: string, runtimeRoot: string): Promise<"closed" | "already_absent" | "unmanaged"> {
		const sessionFile = canonicalPath(piSessionFile);
		if (!sessionFile || dirname(sessionFile) !== canonicalPath(join(runtimeRoot, "collaborator-sessions"))) return "unmanaged";
		const find = async () => (await this.listAgents()).filter((agent) => agent.sessionPath === sessionFile);
		const matches = await find();
		const [agent] = matches;
		if (!agent) return "already_absent";
		if (matches.length !== 1) throw new RuntimeError("identity_mismatch", "Collaborator session is not unique in Herdr.");
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
		if (!tabId || !workspaceId) throw new RuntimeError("identity_mismatch", "Collaborator has no exact Herdr tab identity.");
		const result = await runHerdr(["tab", "get", tabId]);
		const tab = decodeHerdr(HerdrTabResultSchema, result, "Herdr tab").tab;
		if (tab.tab_id !== tabId || tab.workspace_id !== workspaceId || tab.pane_count !== 1) {
			throw new RuntimeError("identity_mismatch", "Collaborator tab identity changed before stop.");
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
		const result = await runHerdr(["agent", "list"]);
		return decodeAgents(HerdrLiveAgentListSchema, result).agents.map(liveAgent);
	}
}

/** A Herdr answer Runtime cannot read is an unanswered query, never a proven identity. */
function decodeAgents<Schema extends TSchema>(schema: Schema, result: JsonObject): Static<Schema> {
	try {
		return decodeHerdr(schema, result, "Herdr agent");
	} catch {
		throw new RuntimeError("host_unavailable", "Herdr returned malformed agent identity.");
	}
}

function liveAgent(agent: HerdrLiveAgent): HostedLiveAgent {
	const result: HostedLiveAgent = { cwd: agent.cwd };
	if (agent.name !== undefined) result.name = agent.name;
	if (agent.agent_status !== undefined) result.agentStatus = agent.agent_status;
	if (agent.state_change_seq !== undefined) result.stateSeq = agent.state_change_seq;
	if (agent.interactive_ready !== undefined) result.ready = agent.interactive_ready;
	if (agent.tab_id !== undefined) result.tabId = agent.tab_id;
	if (agent.workspace_id !== undefined) result.workspaceId = agent.workspace_id;
	const sessionPath = agent.agent_session?.kind === "path" ? canonicalPath(agent.agent_session.value) : undefined;
	if (sessionPath !== undefined) result.sessionPath = sessionPath;
	return result;
}

function canonicalPath(path: string): string | undefined {
	try { return realpathSync(path); } catch { return undefined; }
}

async function runHerdr(args: string[]): Promise<JsonObject> {
	const stdout = await execHerdr(args);
	try { return herdrResult(stdout); } catch { throw new RuntimeError("host_unavailable", "Herdr returned invalid JSON."); }
}

/** A command whose exit status is the whole answer; only queries also have to decode a result envelope. */
function execHerdr(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("herdr", args, { timeout: 2_000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) reject(herdrQueryFailure(stdout));
			else resolve(stdout);
		});
	});
}

/** A structured Herdr error means Herdr answered and the agent is absent; anything else is an unanswered query. */
function herdrQueryFailure(stdout: string): RuntimeError {
	if (stdout.length > 8192) return new RuntimeError("host_unavailable", "Herdr identity query failed.");
	try {
		// SAFETY: Herdr CLI output is untrusted JSON, narrowed to an error object before it is trusted.
		const response = JSON.parse(stdout) as JsonObject | undefined;
		if (!isJsonObject(response) || !isJsonObject(response.error)) throw new Error("unstructured output");
		return new RuntimeError("identity_mismatch", "Herdr reports no such agent.");
	} catch {
		return new RuntimeError("host_unavailable", "Herdr identity query failed.");
	}
}
