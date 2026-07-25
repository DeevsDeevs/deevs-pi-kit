import { describe, expect, it } from "vitest";
import { createBoundedByteTail, createBoundedLineReader } from "../extensions/subagents/protocol.ts";

describe("delegate child protocol bounds", () => {
	it("frames lines across chunks and flushes the final line", () => {
		const lines: string[] = [];
		const reader = createBoundedLineReader({ stream: "stdout", maxPendingLineBytes: 100, onLine: (line) => lines.push(line), onLimit: () => undefined });
		reader.push("one\ntw");
		reader.push("o\nthree");
		reader.end();
		expect(lines).toEqual(["one", "two", "three"]);
	});

	it("stops accepting data after a protocol line limit", () => {
		const limits: number[] = [];
		const reader = createBoundedLineReader({ stream: "stdout", maxPendingLineBytes: 4, onLine: () => undefined, onLimit: (limit) => limits.push(limit.observedBytes) });
		reader.push("12345");
		reader.push("ignored\n");
		expect(reader.exceeded()).toBe(true);
		expect(limits).toEqual([5]);
	});

	it("keeps a valid UTF-8 byte tail", () => {
		const tail = createBoundedByteTail(8);
		tail.push("prefix 👩🏽‍💻 tail");
		expect(Buffer.byteLength(tail.text())).toBeLessThanOrEqual(8);
		expect(tail.text()).not.toContain("�");
	});
});
