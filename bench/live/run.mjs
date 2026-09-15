import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostedRuntimeClient } from "../../extensions/runtime/client.ts";
import { countWakes, discoverTranscript, loadTranscript, transcriptPath } from "./transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARENA = "/home/deevs/agents/pi-kit-bench/arena";
const WORKSPACE = "w1N";
const RUNTIME_ROOT = join(homedir(), ".pi", "agent", "runtime");
const SOCKET = join(RUNTIME_ROOT, "runtime.sock");
const STATE = join(RUNTIME_ROOT, "state.v1.json");
const SCRATCH = "/tmp/claude-1000/-home-deevs-agents-deevs-pi-kit/5a7dc0ce-11c4-4586-a76b-584e0ba40c6f/scratchpad/bench";
const BODY_BYTES = 8192;
const TICK_MS = 100;
const REPLY_TIMEOUT_MS = 240_000;
const SILENT_WAIT_MS = 100_000;
const LEAD_MODEL = "openai-codex/gpt-5.6-terra";

const LANES = {
	claude: { drivers: [["claude-code", "sonnet"]], count: 3 },
	codex: { drivers: [["codex", "gpt-5.6-terra"]], count: 3 },
	pi: { drivers: [["pi", "openai-codex/gpt-5.6-terra"]], count: 3 },
	fanout: { drivers: [["claude-code", "sonnet"], ["codex", "gpt-5.6-terra"]], count: 12, broadcast: true },
};

const findings = [];
const note = (text) => { findings.push(text); console.error(`# ${text}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function args(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, "")] = argv[i + 1];
	const lane = flags.lane;
	if (!LANES[lane]) throw new Error(`--lane must be one of ${Object.keys(LANES).join("|")}`);
	return { lane, mails: Number(flags.mails ?? 10), collaborators: Number(flags.collaborators ?? LANES[lane].count) };
}

function herdr(...argv) {
	const out = execFileSync("herdr", argv, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
	return out ? JSON.parse(out) : {};
}

function herdrText(...argv) {
	return execFileSync("herdr", argv, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

/** The lead's own identity commands still confirm in its TUI; auto mode only covers collaborator lifecycle. */
async function confirmDialog(pane, expected, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (herdrText("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "40").includes(expected)) {
			// Pi confirmations are select lists with Yes preselected, so enter is the answer, never a "y" keystroke.
			herdr("pane", "send-keys", pane, "enter");
			return true;
		}
		await sleep(500);
	}
	return false;
}

function command(pane, text) {
	herdr("pane", "send-text", pane, text);
	herdr("pane", "send-keys", pane, "enter");
}

function heldParticipant(protocol, participantId) {
	return Object.values(readState().participants)
		.find(p => p.projectRoot === ARENA && p.protocol === protocol && p.participantId === participantId && p.state === "held");
}

function readState() {
	return JSON.parse(readFileSync(STATE, "utf8"));
}

/** c1..cK: one driver per lane, alternating for fanout; c3 writes in the single-driver lanes. */
function collaboratorPlan(lane, count) {
	const { drivers, broadcast } = LANES[lane];
	return Array.from({ length: count }, (_unused, index) => {
		const [driver, model] = drivers[index % drivers.length];
		const profile = !broadcast && index === 2 ? "workspace-write" : "read-only";
		return { id: `c${index + 1}`, driver, model, profile };
	});
}

function expandBody(scenario, token) {
	if (!scenario.body.includes(token)) return scenario.body;
	const base = scenario.body.replace(token, "");
	return base + "x".repeat(Math.max(0, BODY_BYTES - Buffer.byteLength(base)));
}

async function main() {
	const { lane, mails, collaborators } = args(process.argv.slice(2));
	const plan = collaboratorPlan(lane, collaborators);
	const catalogue = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));
	const scenarios = catalogue.scenarios.slice(0, mails);
	mkdirSync(SCRATCH, { recursive: true });

	const client = new HostedRuntimeClient(SOCKET, 20_000, 256 * 1024);
	// One stable fake session per lane, so a rerun re-registers the same Pi target instead of orphaning the last one.
	const sessionId = `bench-${lane}`;
	const sessionFile = join(SCRATCH, `${sessionId}.jsonl`);
	writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: ARENA })}\n`);
	const auth = authOf(await client.call("pi.register", { projectRoot: ARENA, piSessionId: sessionId, piSessionFile: sessionFile }));
	const heartbeat = setInterval(() => { void client.call("pi.heartbeat", auth).catch(() => {}); }, 10_000);
	const bench = await acquireBench(client, auth, lane);
	const issued = await client.call("messaging.issue", { ...auth, participantKey: bench.participantKey, expectedGeneration: bench.generation, confirmed: true });
	const descriptor = JSON.parse(readFileSync(issued.descriptorPath, "utf8"));
	const mailAuth = { namespaceId: descriptor.namespaceId, secret: descriptor.secret };
	const send = (participantId, body) => client.call("messaging.send", { ...mailAuth, operationId: randomUUID(), participantId, bodyBase64: Buffer.from(body).toString("base64") });
	const replyTo = (eventId, body) => client.call("messaging.reply", { ...mailAuth, operationId: randomUUID(), eventId, bodyBase64: Buffer.from(body).toString("base64") });

	const started = Date.now();
	let tabId;
	let leadPane;
	const leadName = `${lane}-lead`;
	const record = { lane, startedAt: started, collaborators: [], mails: [], scenarios: [], findings };
	try {
		const tab = herdr("tab", "create", "--workspace", WORKSPACE, "--cwd", ARENA, "--no-focus", "--label", `bench-${lane}`).result;
		const pane = tab.root_pane.pane_id;
		leadPane = pane;
		tabId = tab.tab_id ?? tab.root_pane.tab_id;
		await sleep(4000);
		herdr("agent", "start", leadName, "--kind", "pi", "--pane", pane, "--timeout", "60000", "--", "--model", LEAD_MODEL);
		await waitAgent(leadName, 60_000);
		command(pane, "/runtime auto on");
		await sleep(3000);
		await waitAgent(leadName, 30_000);
		// Pi has no session file — and so no Runtime registration — until its first message.
		herdr("agent", "prompt", leadName, "Reply with just: ok");
		await waitAgent(leadName, 60_000);
		if (heldParticipant(lane, "lead")) {
			note(`${lane}/lead was still held by an earlier lead tab; recovering it with /runtime takeover`);
			command(pane, `/runtime takeover ${lane} lead`);
			if (!await confirmDialog(pane, "Take over collaborator identity?")) note("the takeover confirmation never appeared");
			await waitAgent(leadName, 30_000);
		}

		const request = plan.map(c => `${c.id} driver ${c.driver} model ${c.model} profile ${c.profile}`).join("; ");
		herdr("agent", "prompt", leadName, `Start collaborators in protocol ${lane} with callerParticipantId lead: ${request}`);
		const live = await waitParticipants(client, auth, lane, plan.map(c => c.id), 300_000);
		if (!live) throw new Error("collaborators did not become held and live");
		const state = readState();
		for (const c of plan) {
			const status = live.find(p => p.participantId === c.id);
			// The participant names its current holder; a Pi holder is found in Herdr by its session file, a native one by agent name.
			const target = state.targets[state.participants[status.participantKey]?.holderTargetKey];
			if (!target) throw new Error(`no Runtime target for ${c.id}`);
			if (!target.agentName) target.agentName = herdr("agent", "list").result.agents.find(a => a.agent_session?.value === target.piSessionFile)?.name;
			if (!target.agentName) throw new Error(`no Herdr agent for ${c.id}`);
			const agent = await waitAgentSession(target.agentName, 10_000);
			record.collaborators.push({
				...c,
				participantKey: status.participantKey,
				agentName: target.agentName,
				cwd: agent.cwd,
				agentSession: agent.agent_session?.value,
				transcript: agent.agent_session?.value
					? transcriptPath(c.driver, agent.agent_session.value, agent.cwd)
					: discoverTranscript(c.driver, agent.cwd, target.createdAt),
			});
		}
		await runScenarios({ client, send, replyTo, mailAuth, lane, record, scenarios, catalogue, broadcast: LANES[lane].broadcast });
	} catch (error) {
		note(`run failed: ${error.message}`);
		record.error = error.message;
	} finally {
		clearInterval(heartbeat);
		await teardown({ client, auth, lane, leadName, plan, record, tabId, pane: leadPane });
		for (const collaborator of record.collaborators) ensureTranscript(record, collaborator);
		record.finishedAt = Date.now();
		const out = join(HERE, "..", "results", "live");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, `${lane}.json`), `${JSON.stringify(record, null, "\t")}\n`);
		console.log(`wrote ${join(out, `${lane}.json`)}`);
		// Stand down rather than release: a released participant ends, and an ended one needs explicit revival.
		await client.call("participant.stand_down", { ...auth, participantKey: bench.participantKey }).catch(() => {});
		await client.call("pi.unregister", auth).catch(() => {});
	}
	if (record.error) process.exitCode = 1;
}

/** A crashed earlier run can leave `bench` held by a dead Pi target; taking it over is the protocol's own recovery. */
async function acquireBench(client, auth, lane) {
	try {
		return (await client.call("participant.acquire", { ...auth, protocol: lane, participantId: "bench", revive: true })).participant;
	} catch (error) {
		if (error.code !== "conflict") throw error;
		const stale = Object.values(readState().participants)
			.find(p => p.projectRoot === ARENA && p.protocol === lane && p.participantId === "bench");
		if (!stale) throw error;
		note(`bench was still held by a previous run's target; taking it over (${stale.generation})`);
		await client.call("participant.takeover", { ...auth, participantKey: stale.participantKey, expectedGeneration: stale.generation, confirmed: true });
		return (await client.call("participant.acquire", { ...auth, protocol: lane, participantId: "bench", revive: true })).participant;
	}
}

function authOf(registration) {
	return { registrationId: registration.registrationId, registrationKey: registration.registrationKey };
}

/** Herdr reports a native agent ready before it knows its session id, and the transcript is named by that id. */
async function waitAgentSession(name, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let agent;
	while (Date.now() < deadline) {
		agent = herdr("agent", "get", name).result.agent;
		if (agent.agent_session?.value) return agent;
		await sleep(500);
	}
	note(`${name} never reported an agent session; its transcript cannot be scored`);
	return agent;
}

function agentSnapshot(name) {
	const agent = herdr("agent", "get", name).result.agent;
	return { status: agent.agent_status, seq: agent.state_change_seq };
}

async function waitAgent(name, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		let status;
		try { status = herdr("agent", "get", name).result?.agent?.agent_status; } catch { status = undefined; }
		if (status === "idle" || status === "done") return status;
		if (status === "blocked") note(`${name} is blocked on a prompt`);
		await sleep(500);
	}
	throw new Error(`${name} did not settle within ${timeoutMs} ms`);
}

async function waitParticipants(client, auth, protocol, ids, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { participants } = await client.call("participant.list", auth);
		const mine = participants.filter(p => p.protocol === protocol && ids.includes(p.participantId));
		if (mine.length === ids.length && mine.every(p => p.state === "held" && p.holderLive)) return mine;
		await sleep(1000);
	}
	return undefined;
}

async function waitVacated(client, auth, protocol, ids, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { participants } = await client.call("participant.list", auth);
		const mine = participants.filter(p => p.protocol === protocol && ids.includes(p.participantId));
		if (mine.every(p => p.state !== "held")) return true;
		await sleep(1000);
	}
	return false;
}

/**
 * One tick reads every agent status in a single `herdr agent list`, drains bench's inbox, and runs
 * the per-mail observers; every wait in the run is built from it, so nothing polls on its own schedule.
 */
function makeTicker(inbox) {
	const ticker = { received: [], statuses: new Map(), observers: [] };
	ticker.tick = async () => {
		const at = Date.now();
		for (const agent of herdr("agent", "list").result.agents) {
			if (agent.name) ticker.statuses.set(agent.name, { status: agent.agent_status, seq: agent.state_change_seq, at });
		}
		const page = await inbox().catch(() => undefined);
		if (page?.messages?.length) {
			const events = readState().events;
			for (const message of page.messages) {
				ticker.received.push({ ...message, at: Date.now(), inReplyToEventId: events[message.eventId]?.inReplyToEventId });
			}
		}
		for (const observe of ticker.observers) observe();
	};
	ticker.until = async (check, timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const before = Date.now();
			await ticker.tick();
			const value = check();
			if (value) return value;
			if (Date.now() >= deadline) return undefined;
			await sleep(Math.max(0, TICK_MS - (Date.now() - before)));
		}
	};
	return ticker;
}

async function runScenarios(context) {
	const { client, record, scenarios, catalogue, broadcast, mailAuth } = context;
	const ticker = makeTicker(() => client.call("messaging.inbox", mailAuth));
	let index = 0;
	for (const scenario of scenarios) {
		const body = expandBody(scenario, catalogue.fillerToken);
		const readOnly = record.collaborators.filter(c => c.profile === "read-only");
		const pool = broadcast
			? record.collaborators
			: [scenario.readOnly && readOnly.length ? readOnly[index % readOnly.length] : record.collaborators[index % record.collaborators.length]];
		index += 1;
		for (const collaborator of pool) {
			record.scenarios.push(await runScenario({ ...context, ticker, scenario, body, collaborator }));
		}
	}
}

async function runScenario(context) {
	const { scenario, body, collaborator, record, ticker, send, replyTo } = context;
	if (scenario.expect === "peer" && record.collaborators.length < 2) {
		return { id: scenario.id, collaborator: collaborator.id, outcome: "skipped", reason: "peer scenario needs two collaborators" };
	}
	const first = await postMail({ ...context, body, label: scenario.id });
	const extra = [];
	if (scenario.follow === "immediate") extra.push(await postMail({ ...context, body: scenario.followBody, label: `${scenario.id}+burst` }));
	if (scenario.follow === "while-working") {
		await ticker.until(() => first.tWorking !== undefined, 60_000);
		extra.push(await postMail({ ...context, body: scenario.followBody, label: `${scenario.id}+overlap` }));
	}
	const pending = [first, ...extra];
	const timeout = scenario.expect === "none" ? SILENT_WAIT_MS : REPLY_TIMEOUT_MS;
	await ticker.until(() => pending.every(mail => mail.replyEventId), timeout);
	if (scenario.follow === "reply" && first.replyEventId) {
		const followed = await postMail({ ...context, body: scenario.followBody, label: `${scenario.id}+chain`, inReplyTo: first.replyEventId, replyTo });
		extra.push(followed);
		await ticker.until(() => followed.replyEventId !== undefined, REPLY_TIMEOUT_MS);
	}
	const all = [first, ...extra];
	const settledAt = Date.now();
	const rows = loadTranscript(collaborator.driver, ensureTranscript(record, collaborator));
	for (const mail of all) {
		// A mail's window ends at its own reply, so two mails of one scenario never count each other's turns.
		mail.settledAt = mail.tReply === undefined ? settledAt : mail.sentAt + mail.tReply;
		mail.wakes = countWakes(rows, mail.sentAt, settledAt);
		mail.outcome = mail.replyEventId ? "reply" : "none";
		record.mails.push(mail);
	}
	return summarize(scenario, collaborator, all, context);
}

/** Claude and Codex write their transcript only on the first turn, well after Herdr reports the agent. */
function ensureTranscript(record, collaborator) {
	if (!collaborator.transcript) {
		const taken = record.collaborators.map(other => other.transcript).filter(Boolean);
		collaborator.transcript = discoverTranscript(collaborator.driver, collaborator.cwd, record.startedAt, taken);
	}
	return collaborator.transcript;
}

/** Send one mail and start its clocks: the tick loop fills in working and reply as they are observed. */
async function postMail(context) {
	const { collaborator, ticker, send, replyTo, body, label, inReplyTo, scenario } = context;
	const before = agentSnapshot(collaborator.agentName);
	const sentAt = Date.now();
	const sent = inReplyTo ? await replyTo(inReplyTo, body) : await send(collaborator.id, body);
	const mail = {
		statusAtSend: before.status,
		seqAtSend: before.seq,
		scenario: scenario.id,
		mailId: label,
		collaborator: collaborator.id,
		eventId: sent.eventId,
		sentAt,
		bytes: Buffer.byteLength(body),
		body: body.length > 160 ? `${body.slice(0, 160)}…` : body,
	};
	watch(ticker, mail, collaborator);
	return mail;
}

/** The per-mail observers the tick loop runs: first `working` status, then the reply carrying this event id. */
function watch(ticker, mail, collaborator) {
	ticker.observers.push(() => {
		// Herdr's status alone is stale right after a send, so a turn counts only once its state sequence moved.
		const status = ticker.statuses.get(collaborator.agentName);
		const started = status && status.at > mail.sentAt && status.seq !== mail.seqAtSend && !["idle", "done"].includes(status.status);
		if (mail.tWorking === undefined && started) {
			mail.tWorking = status.at - mail.sentAt;
			mail.workingStatus = status.status;
		}
		if (mail.replyEventId) return;
		// A collaborator that answers with collaborator_send instead of collaborator_reply carries no
		// inReplyToEventId, so an unattributed message from it counts for the oldest mail still waiting.
		const reply = ticker.received.find(message => message.inReplyToEventId === mail.eventId && !message.claimed)
			?? ticker.received.find(message => message.from === collaborator.id && !message.claimed && message.inReplyToEventId === undefined);
		if (!reply) return;
		reply.claimed = true;
		mail.replyEventId = reply.eventId;
		mail.replyBody = reply.body.length > 400 ? `${reply.body.slice(0, 400)}…` : reply.body;
		mail.tReply = reply.at - mail.sentAt;
		mail.correlated = reply.inReplyToEventId === mail.eventId ? "reply" : "send";
	});
}

function summarize(scenario, collaborator, mails, context) {
	const { record } = context;
	const replied = mails.filter(mail => mail.replyEventId).length;
	const result = {
		id: scenario.id,
		collaborator: collaborator.id,
		expect: scenario.expect,
		mails: mails.map(mail => mail.mailId),
		replies: replied,
		wakes: mails.reduce((total, mail) => total + mail.wakes, 0),
	};
	if (scenario.expect === "none") result.outcome = replied === 0 ? "pass" : "fail";
	else if (scenario.expect === "peer") {
		result.peerMail = peerMailSent(record, collaborator, scenario.peer, mails[0].sentAt);
		result.outcome = replied === mails.length && result.peerMail ? "pass" : "fail";
	} else result.outcome = replied === mails.length ? "pass" : "fail";
	if (scenario.match && mails[0].replyBody) result.matched = new RegExp(scenario.match, "i").test(mails[0].replyBody.trim());
	if (scenario.followMatch && mails[1]?.replyBody) result.followMatched = new RegExp(scenario.followMatch, "i").test(mails[1].replyBody.trim());
	if (scenario.check?.startsWith("no-file:")) {
		const path = join(ARENA, scenario.check.slice("no-file:".length));
		result.fileCreated = existsSync(path);
		if (result.fileCreated) {
			note(`${collaborator.id} (${collaborator.profile}) created ${path} despite its profile`);
			rmSync(path, { force: true });
			result.outcome = "fail";
		}
	}
	return result;
}

function peerMailSent(record, sender, peerId, since) {
	const peer = record.collaborators.find(c => c.id === peerId);
	if (!peer) return false;
	const events = Object.values(readState().events);
	return events.some(event => event.source.id === sender.participantKey && event.recipientParticipantKey === peer.participantKey && event.createdAt >= since);
}

async function teardown({ client, auth, lane, leadName, plan, record, tabId, pane }) {
	if (!tabId) return;
	try {
		const ids = plan.map(c => c.id);
		herdr("agent", "prompt", leadName, `Stop ${ids.join(", ")} (protocol ${lane}).`);
		if (!await waitVacated(client, auth, lane, ids, 240_000)) {
			note("lead did not vacate every collaborator; closing their tabs directly");
			for (const target of Object.values(readState().targets)) {
				const held = record.collaborators.find(c => c.participantKey === target.participantKey);
				if (held && target.herdr?.tabId) { try { herdr("tab", "close", target.herdr.tabId); } catch {} }
			}
		}
		const writer = plan.find(c => c.profile === "workspace-write");
		if (writer) {
			herdr("agent", "prompt", leadName, `Run collaborator_workspace cleanup for ${writer.id}.`);
			await waitAgent(leadName, 120_000).catch(() => note("lead did not settle after the worktree cleanup"));
		}
		// Stand-down, not leave: an ended lead identity cannot be acquired again without explicit revival.
		command(pane, "/runtime stand-down");
		await sleep(3000);
	} catch (error) {
		note(`teardown problem: ${error.message}`);
	} finally {
		try { herdr("tab", "close", tabId); } catch (error) { note(`could not close ${tabId}: ${error.message}`); }
	}
}

await main();
