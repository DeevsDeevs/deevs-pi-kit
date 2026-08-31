import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

if (process.env.HERDR_ENV !== "1") throw new Error("Interactive native live smoke must run inside Herdr.");

const project = process.cwd();
const initialPane = currentPane();
const versions = {
	claude: run("claude", ["--version"]).trim(),
	codex: run("codex", ["--version"]).trim(),
};
const results = [];

for (const driver of ["claude-code", "codex"]) {
	for (const profile of ["read-only", "workspace-write"]) results.push(runAgentGate(driver, profile));
}
if (currentPane() !== initialPane) throw new Error("Interactive native smoke changed the focused pane.");
console.log(JSON.stringify({ versions, focus: "unchanged", results }, null, 2));

function runAgentGate(driver, profile) {
	const kind = driver === "claude-code" ? "claude" : "codex";
	const label = `${kind}-${profile}`;
	const marker = join(project, `${label}.txt`);
	const created = json(run("herdr", ["tab", "create", "--cwd", project, "--label", `native-smoke:${label}`, "--no-focus"]));
	const paneId = created.result.root_pane.pane_id;
	const tabId = created.result.tab.tab_id;
	try {
		const agentName = `smoke-${kind}-${profile === "read-only" ? "ro" : "rw"}`;
		const started = json(run("herdr", ["agent", "start", agentName, "--kind", kind, "--pane", paneId, "--timeout", "120000", "--", ...agentArgs(driver, profile, project)]));
		const agent = started.result.agent;
		const agentSession = managedAgentIdentity(agent);
		if (agent.pane_id !== paneId || agent.tab_id !== tabId || agent.agent !== kind || agent.name !== agentName || agentSession.source !== `herdr:${kind}` || agentSession.agent !== kind || agentSession.value !== agentName) throw new Error(`${label} returned the wrong interactive agent identity.`);
		const prompt = profile === "read-only"
			? `Attempt to create ${marker} containing forbidden. Do not use another path. Finish the turn even when tools deny the write.`
			: `Create ${marker} with the exact text ${label} followed by one newline, then finish.`;
		run("herdr", ["agent", "prompt", paneId, prompt, "--wait", "--until", "idle", "--until", "done", "--timeout", "180000"]);
		if (profile === "read-only" && existsSync(marker)) throw new Error(`${label} modified the workspace.`);
		if (profile === "workspace-write" && readFileSync(marker, "utf8") !== `${label}\n`) throw new Error(`${label} did not create the exact file.`);
		const live = json(run("herdr", ["agent", "get", paneId])).result.agent;
		if (JSON.stringify(managedAgentIdentity(live)) !== JSON.stringify(agentSession)) throw new Error(`${label} changed agent session identity.`);
		return { driver, profile, interactiveSession: "passed", runtimePromptTransport: "passed", profileEnforcement: "passed", agentSession };
	} finally {
		rmSync(marker, { force: true });
		run("herdr", ["tab", "close", tabId]);
		try { run("herdr", ["agent", "get", paneId]); throw new Error(`${label} remained live after exact tab close.`); } catch (error) {
			if (error instanceof Error && error.message.includes("remained live")) throw error;
		}
	}
}

function managedAgentIdentity(agent) {
	return agent.agent_session ?? { source: `herdr:${agent.agent}`, agent: agent.agent, kind: "id", value: agent.name };
}

function agentArgs(driver, profile, cwd) {
	if (driver === "claude-code") return ["--safe-mode", "--permission-mode", profile === "read-only" ? "dontAsk" : "acceptEdits", "--tools", profile === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write"];
	return ["--ask-for-approval", "never", "--sandbox", profile, "--disable", "hooks", "--config", `projects={ ${JSON.stringify(cwd)} = { trust_level = "trusted" } }`];
}

function currentPane() {
	return json(run("herdr", ["pane", "current", "--current"])).result.pane.pane_id;
}

function run(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: "utf8", timeout: 210_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function json(value) {
	const parsed = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || !parsed.result) throw new Error("Herdr returned malformed JSON.");
	return parsed;
}
