import { readFileSync } from "node:fs";
import { body, percentiles, pool, round, run, setup, sleep, withRetry } from "./harness.mjs";

const SENDS = Number(process.env.BENCH_SENDS ?? 300);
const CONCURRENCY = 16;
const KILL_AFTER = Math.floor(SENDS / 2);

await run("restart", async ({ metrics, check }) => {
	const bench = await setup();
	bench.keepAlive();
	const sender = await bench.addPi("sender");
	const recipient = await bench.addPi("recipient");
	const operations = Array.from({ length: SENDS }, (_unused, index) => `op_${index}`);
	const send = (rpc, operationId) => rpc.call("messaging.send", {
		...sender.namespace,
		operationId,
		participantId: recipient.name,
		bodyBase64: body(`restart ${operationId}`),
	});

	const acked = new Map();
	const latencies = [];
	let unacked = [];
	let lanes = await Promise.all(Array.from({ length: CONCURRENCY }, () => bench.connect()));
	const killed = (async () => {
		while (acked.size < KILL_AFTER) await sleep(2);
		const at = acked.size;
		await bench.kill("SIGKILL");
		return at;
	})();

	await pool(CONCURRENCY, operations, async (operationId, lane) => {
		const at = performance.now();
		try {
			const result = await withRetry(() => send(lanes[lane], operationId));
			latencies.push(performance.now() - at);
			acked.set(operationId, result.eventId);
		} catch {
			unacked.push(operationId);
		}
	});
	metrics.killedAtAcks = await killed;
	metrics.ackedBeforeKill = acked.size;
	metrics.unackedAfterKill = unacked.length;
	metrics.committedBeforeRestart = countEvents(bench.statePath, recipient.participant.participantKey);
	metrics.lostAcks = metrics.committedBeforeRestart - metrics.ackedBeforeKill;

	await bench.start();
	await bench.reregister();
	lanes = await Promise.all(Array.from({ length: CONCURRENCY }, () => bench.connect()));

	// Same operation ID, so a send that committed before the kill answers with its original event.
	let retryRounds = 0;
	while (unacked.length > 0 && retryRounds < 5) {
		retryRounds++;
		const pending = unacked;
		unacked = [];
		await pool(CONCURRENCY, pending, async (operationId, lane) => {
			try {
				const result = await withRetry(() => send(lanes[lane], operationId));
				acked.set(operationId, result.eventId);
			} catch (error) {
				unacked.push(`${operationId}: ${error.code ?? error.message}`);
			}
		});
	}
	metrics.retriedOperations = metrics.unackedAfterKill;
	metrics.retryRounds = retryRounds;
	metrics.stillUnacked = unacked;
	metrics.ackLatencyMs = percentiles(latencies);

	const delivered = new Map();
	for (;;) {
		const page = await withRetry(() => bench.control.call("messaging.inbox", recipient.namespace));
		if (page.messages.length === 0) break;
		for (const message of page.messages) delivered.set(message.eventId, message.body);
	}
	const byOperation = new Map();
	for (const [eventId, text] of delivered) {
		const operationId = text.replace("restart ", "");
		byOperation.set(operationId, [...(byOperation.get(operationId) ?? []), eventId]);
	}
	const duplicated = [...byOperation].filter(([, events]) => events.length > 1);
	const missing = operations.filter((operationId) => !byOperation.has(operationId));
	metrics.deliveredMessages = delivered.size;
	metrics.distinctOperations = byOperation.size;
	metrics.duplicatedOperations = duplicated.length;
	metrics.missingOperations = missing.length;
	metrics.ackedEventsMatchDelivered = [...acked].every(([operationId, eventId]) => byOperation.get(operationId)?.includes(eventId));
	metrics.retriesNeeded = metrics.retriedOperations;
	metrics.retriesPerSend = round(metrics.retriedOperations / SENDS, 3);

	check(unacked.length === 0, `operations never acknowledged after restart: ${JSON.stringify(unacked.slice(0, 5))}`);
	check(missing.length === 0, `operations lost across the restart: ${JSON.stringify(missing.slice(0, 5))}`);
	check(duplicated.length === 0, `operations duplicated across the restart: ${JSON.stringify(duplicated.slice(0, 5))}`);
	check(delivered.size === SENDS, `inbox delivered ${delivered.size} messages for ${SENDS} operations`);
	check(metrics.ackedEventsMatchDelivered, "an acknowledged event ID was not the one delivered");
});

function countEvents(statePath, participantKey) {
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		return Object.values(state.events).filter((event) => event.recipientParticipantKey === participantKey).length;
	} catch { return -1; }
}
