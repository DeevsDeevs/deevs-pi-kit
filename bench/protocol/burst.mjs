import { auth, body, fileSize, percentiles, pool, round, rssBytes, run, setup, withRetry } from "./harness.mjs";

const NAMESPACES = 8;
const RECIPIENTS = 8;
const SENDS = Number(process.env.BENCH_SENDS ?? 2000);
const CONCURRENCY = 32;

await run("burst", async ({ metrics, check }) => {
	const bench = await setup();
	bench.keepAlive();
	const senders = [];
	const recipients = [];
	for (let index = 0; index < NAMESPACES; index++) senders.push(await bench.addPi(`s${index}`));
	for (let index = 0; index < RECIPIENTS; index++) recipients.push(await bench.addPi(`r${index}`));

	metrics.stateBytesBefore = fileSize(bench.statePath);
	metrics.rssBytesBefore = rssBytes(bench.daemon.pid);

	const lanes = await Promise.all(Array.from({ length: CONCURRENCY }, () => bench.connect()));
	const latencies = [];
	const eventIds = new Set();
	let retries = 0;
	const started = performance.now();
	await pool(CONCURRENCY, Array.from({ length: SENDS }, (_unused, index) => index), async (index, lane) => {
		const sender = senders[index % NAMESPACES];
		const recipient = recipients[index % RECIPIENTS];
		const call = () => lanes[lane].call("messaging.send", {
			...sender.namespace,
			operationId: `op_${index}`,
			participantId: recipient.name,
			bodyBase64: body(`burst ${index} ${"x".repeat(160)}`),
		});
		const at = performance.now();
		const result = await withRetry(call, () => { retries++; });
		latencies.push(performance.now() - at);
		eventIds.add(result.eventId);
	});
	const elapsed = (performance.now() - started) / 1000;

	metrics.sends = SENDS;
	metrics.concurrency = CONCURRENCY;
	metrics.capacityRetries = retries;
	metrics.ackLatencyMs = percentiles(latencies);
	metrics.sendsPerSec = round(SENDS / elapsed);
	metrics.stateBytesAfter = fileSize(bench.statePath);
	metrics.rssBytesAfter = rssBytes(bench.daemon.pid);

	let delivered = 0;
	const deliveredIds = new Set();
	for (const recipient of recipients) {
		for (;;) {
			const page = await withRetry(() => bench.control.call("messaging.inbox", recipient.namespace));
			for (const message of page.messages) deliveredIds.add(message.eventId);
			delivered += page.messages.length;
			if (page.messages.length === 0) break;
		}
	}
	metrics.delivered = delivered;
	metrics.distinctEventIds = eventIds.size;

	check(eventIds.size === SENDS, `expected ${SENDS} distinct event IDs, got ${eventIds.size}`);
	check(delivered === SENDS, `recipient inboxes returned ${delivered} messages, expected ${SENDS}`);
	check(deliveredIds.size === SENDS, `inboxes returned ${deliveredIds.size} distinct event IDs, expected ${SENDS}`);
	await bench.control.call("pi.heartbeat", auth(senders[0]));
});
