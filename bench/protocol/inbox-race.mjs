import { body, percentiles, round, run, setup, withRetry } from "./harness.mjs";

const MESSAGES = Number(process.env.BENCH_MESSAGES ?? 500);
const READERS = 16;
const INBOX_PAGE = 50;

await run("inbox-race", async ({ metrics, check }) => {
	const bench = await setup();
	bench.keepAlive();
	const sender = await bench.addPi("sender");
	const recipient = await bench.addPi("recipient");

	for (let index = 0; index < MESSAGES; index++) {
		await bench.control.call("messaging.send", {
			...sender.namespace,
			operationId: `fill_${index}`,
			participantId: recipient.name,
			bodyBase64: body(`race ${index}`),
		});
	}

	const seen = new Map();
	const latencies = [];
	const counts = [];
	let retries = 0;
	const readers = await Promise.all(Array.from({ length: READERS }, () => bench.connect()));
	const started = performance.now();
	await Promise.all(readers.map(async (rpc, reader) => {
		let mine = 0;
		for (;;) {
			const at = performance.now();
			const page = await withRetry(() => rpc.call("messaging.inbox", recipient.namespace), () => { retries++; });
			latencies.push(performance.now() - at);
			if (page.messages.length === 0) break;
			mine += page.messages.length;
			if (page.messages.length > INBOX_PAGE) throw new Error(`inbox returned ${page.messages.length} messages, over the ${INBOX_PAGE} cap`);
			for (const message of page.messages) seen.set(message.eventId, [...(seen.get(message.eventId) ?? []), reader]);
		}
		counts.push(mine);
	}));
	const elapsed = (performance.now() - started) / 1000;

	const duplicates = [...seen].filter(([, readersSeen]) => readersSeen.length > 1);
	metrics.messages = MESSAGES;
	metrics.readers = READERS;
	metrics.delivered = [...seen.values()].reduce((total, readersSeen) => total + readersSeen.length, 0);
	metrics.distinctDelivered = seen.size;
	metrics.duplicates = duplicates.length;
	metrics.perReader = counts.sort((left, right) => right - left);
	metrics.capacityRetries = retries;
	metrics.inboxLatencyMs = percentiles(latencies);
	metrics.totalSec = round(elapsed);
	metrics.inboxCallsPerSec = round(latencies.length / elapsed);

	check(duplicates.length === 0, `event IDs returned to more than one reader: ${JSON.stringify(duplicates.slice(0, 5))}`);
	check(seen.size === MESSAGES, `expected ${MESSAGES} distinct delivered event IDs, got ${seen.size}`);
	check(metrics.delivered === MESSAGES, `${metrics.delivered} deliveries for ${MESSAGES} messages`);
});
