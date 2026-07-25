import assert from "node:assert/strict";
import test from "node:test";
import { ReadThrottle } from "./read-throttle.ts";

test("first read is immediate and repeated reads wait for the interval", async () => {
	let now = 1_000;
	const waits: number[] = [];
	const throttle = new ReadThrottle(
		() => now,
		async (ms) => {
			waits.push(ms);
			now += ms;
		},
	);

	await throttle.wait("run", 60_000);
	assert.deepEqual(waits, []);

	now += 1_000;
	await throttle.wait("run", 60_000);
	assert.deepEqual(waits, [59_000]);

	await throttle.wait("run", 60_000);
	assert.deepEqual(waits, [59_000, 60_000]);
});

test("concurrent reads for one id are serialized", async () => {
	let now = 0;
	const waits: number[] = [];
	const throttle = new ReadThrottle(
		() => now,
		async (ms) => {
			waits.push(ms);
			now += ms;
		},
	);

	await throttle.wait("run", 100);
	await Promise.all([throttle.wait("run", 100), throttle.wait("run", 100)]);
	assert.deepEqual(waits, [100, 100]);
});

test("throttling is independent per id and can be cleared", async () => {
	let now = 0;
	const waits: number[] = [];
	const throttle = new ReadThrottle(
		() => now,
		async (ms) => {
			waits.push(ms);
			now += ms;
		},
	);

	await throttle.wait("run-a", 100);
	await throttle.wait("run-b", 100);
	assert.deepEqual(waits, []);

	throttle.clear("run-a");
	await throttle.wait("run-a", 100);
	assert.deepEqual(waits, []);

	await throttle.wait("run-b", 100);
	assert.deepEqual(waits, [100]);
});

test("an aborted read neither waits nor starts an interval", async () => {
	let sleeps = 0;
	const throttle = new ReadThrottle(
		() => 0,
		async () => {
			sleeps += 1;
		},
	);
	const controller = new AbortController();
	controller.abort();

	await throttle.wait("run", 60_000, controller.signal);
	await throttle.wait("run", 60_000);
	assert.equal(sleeps, 0);
});
