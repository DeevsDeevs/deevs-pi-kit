import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOSTED_METHOD_NAMES } from "../extensions/runtime/service/protocol.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = [
	"README.md",
	"extensions/runtime/PROTOCOL.md",
	"skills/collaborators/SKILL.md",
	"skills/collaborator-messaging/SKILL.md",
];

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

function lineCount(text: string): number {
	return text.trimEnd().split("\n").length;
}

/** The heading line plus everything up to the next heading of the same or higher level. */
function section(text: string, heading: string): string {
	const lines = text.split("\n");
	const start = lines.indexOf(heading);
	expect(start).toBeGreaterThan(-1);
	const boundary = new RegExp(`^#{1,${heading.indexOf(" ")}} `);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => boundary.test(line));
	return [heading, ...(end < 0 ? rest : rest.slice(0, end))].join("\n");
}

function documentedMethods(protocol: string): string[] {
	return [...section(protocol, "## Methods").matchAll(/`([a-z]+(?:\.[a-z_]+)?)`/g)].map((match) => match[1] ?? "");
}

describe("runtime documentation", () => {
	it("documents exactly the dispatchable methods", () => {
		const documented = documentedMethods(read("extensions/runtime/PROTOCOL.md"));
		expect([...documented].sort()).toEqual(["hello", ...HOSTED_METHOD_NAMES].sort());
	});

	it("keeps the reduced docs within their line budgets", () => {
		expect(lineCount(read("extensions/runtime/PROTOCOL.md"))).toBeLessThanOrEqual(120);
		expect(lineCount(section(read("README.md"), "### Hosted runtime"))).toBeLessThanOrEqual(20);
		expect(lineCount(read("skills/collaborators/SKILL.md"))).toBeLessThan(40);
		expect(lineCount(read("skills/collaborator-messaging/SKILL.md"))).toBeLessThan(20);
	});

	it("resolves every relative link", () => {
		for (const doc of DOCS) {
			for (const match of read(doc).matchAll(/]\(([^)#:]+)\)/g)) {
				const target = match[1] ?? "";
				const resolved = join(ROOT, dirname(doc), target);
				expect({ doc, target, exists: existsSync(resolved) }).toEqual({ doc, target, exists: true });
			}
		}
	});
});
