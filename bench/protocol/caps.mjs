import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { HOSTED_MAILBOX_MAX_BODY_BYTES, HOSTED_MAX_STATE_RECORDS, HOSTED_STATE_MAX_BYTES } from "../../extensions/runtime/schemas/common.ts";
import { body, fileSize, repo, round, run, setup, withRetry } from "./harness.mjs";

const protocolSource = readFileSync(join(repo, "extensions/runtime/service/protocol.ts"), "utf8");
const MAX_REQUEST_BYTES = sourceConstant("HOSTED_MAX_REQUEST_BYTES");
const MAX_MESSAGING_RESPONSE_BYTES = sourceConstant("MAX_MESSAGING_RESPONSE_BYTES");
const RECORD_BUDGET_SEC = Number(process.env.BENCH_RECORD_BUDGET_SEC ?? 60);

/** The caps live as expressions (`64 * 1024`); read them from the source rather than restating them here. */
function sourceConstant(name) {
	const match = new RegExp(`${name}\\s*=\\s*([0-9*\\s]+);`).exec(protocolSource);
	if (!match) throw new Error(`cannot read ${name} from service/protocol.ts`);
	return match[1].split("*").reduce((product, part) => product * Number(part.trim()), 1);
}

await run("caps", async ({ metrics, check }) => {
	metrics.caps = {
		bodyBytes: HOSTED_MAILBOX_MAX_BODY_BYTES,
		requestBytes: MAX_REQUEST_BYTES,
		messagingResponseBytes: MAX_MESSAGING_RESPONSE_BYTES,
		stateRecords: HOSTED_MAX_STATE_RECORDS,
		stateBytes: HOSTED_STATE_MAX_BYTES,
	};
	const bench = await setup();
	bench.keepAlive();
	const sender = await bench.addPi("sender");
	const recipient = await bench.addPi("recipient");
	let operation = 0;
	const send = (text, from = sender, to = recipient) => bench.control.call("messaging.send", {
		...from.namespace,
		operationId: `op_${operation++}`,
		participantId: to.name,
		bodyBase64: body(text),
	});
	const alive = async (label) => {
		const sent = await withRetry(() => send(`alive after ${label}`));
		const page = await withRetry(() => bench.control.call("messaging.inbox", recipient.namespace));
		return { sent: sent.eventId, delivered: page.messages.length };
	};

	// 1. A body one byte over the 16 KiB cap.
	metrics.oversizedBody = await expectError(() => send("x".repeat(HOSTED_MAILBOX_MAX_BODY_BYTES + 1)));
	metrics.oversizedBody.stillServing = await alive("oversized body");
	check(metrics.oversizedBody.code === "invalid_request", `oversized body answered ${metrics.oversizedBody.code}`);

	// 2. A request line over the 64 KiB frame cap, written straight to the socket.
	metrics.oversizedRequest = await oversizedLine(bench.socketPath, MAX_REQUEST_BYTES + 4096);
	metrics.oversizedRequest.stillServing = await alive("oversized request line");
	check(metrics.oversizedRequest.code === "invalid_request", `oversized request answered ${metrics.oversizedRequest.code}`);

	// 3. A full inbox page of near-max bodies: the response would exceed 128 KiB.
	const filler = "y".repeat(HOSTED_MAILBOX_MAX_BODY_BYTES);
	const filled = [];
	for (let index = 0; index < 51; index++) filled.push((await withRetry(() => send(filler))).eventId);
	metrics.oversizedResponse = await expectError(() => bench.control.call("messaging.inbox", recipient.namespace));
	const afterOversized = await withRetry(() => bench.control.call("messaging.inbox", recipient.namespace));
	metrics.oversizedResponse.pageMessages = 51;
	metrics.oversizedResponse.nextInboxMessages = afterOversized.messages.length;
	metrics.oversizedResponse.markedReadButNeverDelivered = filled.length - afterOversized.messages.length;
	metrics.oversizedResponse.note = "inbox marks the page read in the same state write, so a page that cannot be encoded is lost mail";
	metrics.oversizedResponse.mailLost = metrics.oversizedResponse.markedReadButNeverDelivered;
	metrics.oversizedResponse.stillServing = await alive("oversized response");
	check(metrics.oversizedResponse.code === "conflict", `oversized response answered ${metrics.oversizedResponse.code}`);

	// 4. Growth to the 8 MiB state cap, with near-max bodies so it is reached in seconds.
	metrics.stateCap = await grow(bench, send, filler, RECORD_BUDGET_SEC);
	metrics.stateCap.helloAfter = (await bench.control.call("hello", { minVersion: 1, maxVersion: 1 })).version;
	metrics.stateCap.participantsAfter = (await bench.control.call("participant.list", { registrationId: sender.reg.registrationId, registrationKey: sender.reg.registrationKey })).participants.length;
	metrics.stateCap.sendAfter = await expectError(() => send("after the state cap"));
	metrics.stateCap.inboxAfter = await expectError(() => bench.control.call("messaging.inbox", recipient.namespace));
	metrics.stateCap.note = `at the state cap the daemon still answers hello and participant.list; the cap rejects only the write that would cross it, so a further small send ${metrics.stateCap.sendAfter.code === "ok" ? "still fits" : `fails with ${metrics.stateCap.sendAfter.code}`}, and this mailbox's inbox answers ${metrics.stateCap.inboxAfter.code} because its page of near-max bodies is itself over the 128 KiB response cap`;
	check(metrics.stateCap.capped, `state cap was not reached: ${JSON.stringify(metrics.stateCap)}`);
	check(metrics.stateCap.helloAfter === 1, "daemon stopped answering hello after the state cap");

	// 5. The 10,000 namespace+operation record cap, on its own daemon with one-byte bodies.
	const records = await setup();
	records.keepAlive();
	const recordSender = await records.addPi("sender");
	const recordRecipient = await records.addPi("recipient");
	let recordOperation = 0;
	const tiny = () => records.control.call("messaging.send", {
		...recordSender.namespace,
		operationId: `op_${recordOperation++}`,
		participantId: recordRecipient.name,
		bodyBase64: body("."),
	});
	metrics.recordCap = await grow(records, tiny, ".", RECORD_BUDGET_SEC);
	metrics.recordCap.records = countRecords(records.statePath);
	metrics.recordCap.recordCapReached = metrics.recordCap.records >= HOSTED_MAX_STATE_RECORDS;
	metrics.recordCap.messagesToStateCap = round(HOSTED_STATE_MAX_BYTES / metrics.recordCap.stateBytesPerMessage, 0);
	metrics.recordCap.note = metrics.recordCap.capped
		? "the state cap fired first: every operation record also stores its event, so the 10,000-record cap is unreachable through messaging.send"
		: `budget of ${RECORD_BUDGET_SEC}s expired before either cap; throughput and growth per message are reported instead, and the state cap is projected to fire at about ${metrics.recordCap.messagesToStateCap} messages, well before 10,000 records`;
	check(metrics.recordCap.records < HOSTED_MAX_STATE_RECORDS || metrics.recordCap.capped, "record growth ended without a cap or a projection");
});

/** Sends until a cap answers or the budget expires; reports what stopped it and how state grew. */
async function grow(bench, send, text, budgetSec) {
	const startBytes = fileSize(bench.statePath);
	const started = performance.now();
	const deadline = started + budgetSec * 1000;
	let messages = 0;
	let capped;
	while (performance.now() < deadline) {
		try {
			await withRetry(() => send(text));
			messages++;
		} catch (error) {
			capped = { code: error.code, message: error.message.slice(0, 200) };
			break;
		}
	}
	const elapsed = (performance.now() - started) / 1000;
	const bytes = fileSize(bench.statePath);
	return {
		capped,
		messages,
		sendsPerSec: round(messages / elapsed),
		stateBytesStart: startBytes,
		stateBytesEnd: bytes,
		stateBytesPerMessage: round((bytes - startBytes) / Math.max(1, messages), 0),
		elapsedSec: round(elapsed),
		budgetExpired: capped === undefined,
	};
}

function countRecords(statePath) {
	const state = JSON.parse(readFileSync(statePath, "utf8"));
	return Object.values(state.messaging).reduce((total, grant) => total + Object.keys(grant.operations).length, Object.keys(state.messaging).length);
}

async function expectError(call) {
	try {
		const result = await call();
		return { code: "ok", message: `no error: ${JSON.stringify(result).slice(0, 120)}` };
	} catch (error) {
		return { code: error.code ?? "unknown", message: error.message.slice(0, 200) };
	}
}

/** A frame the dispatcher must reject before any method runs, sent as raw bytes. */
function oversizedLine(socketPath, bytes) {
	return new Promise((ok, fail) => {
		const socket = createConnection(socketPath);
		let buffered = "";
		let closedWithoutAnswer = true;
		socket.on("data", (chunk) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			closedWithoutAnswer = false;
			const response = JSON.parse(buffered.slice(0, newline));
			socket.destroy();
			ok({ requestBytes: bytes, code: response.error?.code ?? "ok", id: response.id, message: (response.error?.message ?? "").slice(0, 200) });
		});
		socket.on("error", fail);
		socket.on("close", () => { if (closedWithoutAnswer) ok({ requestBytes: bytes, code: "closed", message: "connection closed without an error response" }); });
		socket.on("connect", () => {
			const padding = "p".repeat(bytes);
			socket.write(`${JSON.stringify({ v: 1, id: "req_oversized", method: "hello", params: { minVersion: 1, maxVersion: 1, padding } })}\n`);
		});
	});
}
