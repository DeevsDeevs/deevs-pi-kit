import { describe, expect, it } from "vitest";
import { BoundedJsonlDecoder, parseClosedJson } from "../extensions/runtime/bridge-runner/jsonl.ts";

describe("bounded bridge JSONL", () => {
	it("decodes split UTF-8 frames and requires terminal newlines", () => {
		const lines: string[] = [];
		const decoder = new BoundedJsonlDecoder((line) => lines.push(line), 100, 200);
		const value = Buffer.from(`${JSON.stringify({ type: "text", text: "hé" })}\n`);
		decoder.push(value.subarray(0, value.length - 2));
		decoder.push(value.subarray(value.length - 2));
		decoder.end();
		expect(lines).toHaveLength(1);
		expect(parseClosedJson(lines[0]!, ["type", "text"])).toEqual({ type: "text", text: "hé" });
		const unterminated = new BoundedJsonlDecoder(() => undefined, 100, 200);
		unterminated.push(Buffer.from("{}"));
		expect(() => unterminated.end()).toThrow("unterminated");
	});

	it("rejects invalid UTF-8, newline-free line overflow, and total overflow", () => {
		const invalid = new BoundedJsonlDecoder(() => undefined, 10, 20);
		expect(() => invalid.push(Buffer.from([0xff]))).toThrow("UTF-8");
		const line = new BoundedJsonlDecoder(() => undefined, 4, 20);
		expect(() => line.push(Buffer.from("12345"))).toThrow("frame exceeds");
		const total = new BoundedJsonlDecoder(() => undefined, 10, 5);
		expect(() => total.push(Buffer.from("{}\n{}\n"))).toThrow("stdout exceeds");
	});

	it("rejects malformed, unknown-field, and deeply nested frames", () => {
		expect(() => parseClosedJson("{bad", ["type"])).toThrow("valid JSON");
		expect(() => parseClosedJson(JSON.stringify({ type: "x", extra: true }), ["type"])).toThrow("unknown field");
		let value: unknown = "leaf";
		for (let index = 0; index < 20; index++) value = { nested: value };
		expect(() => parseClosedJson(JSON.stringify({ type: "x", value }), ["type", "value"], 8)).toThrow("depth");
	});
});
