import { basename } from "node:path";
import { utf8Head } from "../shared/bytes.ts";
import { truncateGraphemes } from "../shared/terms.ts";

const STALE_AFTER_DAYS = 7;

export interface ChainLinkMetadata {
	chain?: string;
	branch?: string;
	parent?: string;
	created?: string;
	nextStep?: string;
}

export function extractTitle(content: string, fallbackPath: string): string {
	const body = stripFrontmatter(content);
	const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
	return heading || basename(fallbackPath, ".md");
}

export function parseMetadata(content: string): ChainLinkMetadata {
	const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content);
	if (!match) return {};
	const metadata: ChainLinkMetadata = {};
	for (const line of match[1]!.split(/\r?\n/)) {
		const pair = /^(chain|branch|parent|created|nextStep):\s*(.*)$/.exec(line.trim());
		if (!pair) continue;
		const value = pair[2]!.trim().replace(/^"|"$/g, "");
		if (pair[1] === "chain") metadata.chain = value;
		else if (pair[1] === "branch") metadata.branch = value;
		else if (pair[1] === "parent") metadata.parent = value || undefined;
		else if (pair[1] === "created") metadata.created = value;
		else if (pair[1] === "nextStep") metadata.nextStep = value || undefined;
	}
	return metadata;
}

export function withMetadata(content: string, metadata: Required<Pick<ChainLinkMetadata, "chain" | "branch" | "created">> & Pick<ChainLinkMetadata, "parent" | "nextStep">): string {
	const body = stripFrontmatter(content).trim();
	const lines = ["---", `chain: ${quoteYaml(metadata.chain)}`, `branch: ${quoteYaml(metadata.branch)}`];
	if (metadata.parent) lines.push(`parent: ${quoteYaml(metadata.parent)}`);
	if (metadata.nextStep) lines.push(`nextStep: ${quoteYaml(metadata.nextStep)}`);
	lines.push(`created: ${quoteYaml(metadata.created)}`, "---", "", body, "");
	return lines.join("\n");
}

export function stripFrontmatter(content: string): string {
	return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

export function parseCreatedAt(filename: string, metadata?: ChainLinkMetadata): { iso: string | null; ageDays: number | null; stale: boolean } {
	const fromMetadata = metadata?.created ? new Date(metadata.created) : null;
	const date = fromMetadata && !Number.isNaN(fromMetadata.getTime()) ? fromMetadata : dateFromFilename(filename);
	if (!date) return { iso: null, ageDays: null, stale: false };
	const ageDays = Math.floor((Date.now() - date.getTime()) / 86_400_000);
	return { iso: date.toISOString(), ageDays, stale: ageDays > STALE_AFTER_DAYS };
}

export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	// 255-byte filename minus timestamp, separator, largest collision suffix, and .md.
	return truncateGraphemes(slug, 80, 228) || "chain-link";
}

export function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= maxBytes) return { text: value, truncated: false };
	const suffix = `\n\n[chain content truncated to ${maxBytes} bytes]`;
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	const text = suffixBytes >= maxBytes ? utf8Head(suffix, maxBytes) : `${utf8Head(value, maxBytes - suffixBytes)}${suffix}`;
	return { text, truncated: true };
}


function dateFromFilename(filename: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{4,9})-/.exec(filename);
	if (!match) return null;
	const [, year, month, day, stamp] = match;
	const hour = Number(stamp.slice(0, 2));
	const minute = Number(stamp.slice(2, 4));
	const second = stamp.length >= 6 ? Number(stamp.slice(4, 6)) : 0;
	const millisecond = stamp.length >= 9 ? Number(stamp.slice(6, 9)) : 0;
	const date = new Date(Number(year), Number(month) - 1, Number(day), hour, minute, second, millisecond);
	return Number.isNaN(date.getTime()) ? null : date;
}

function quoteYaml(value: string): string {
	return JSON.stringify(value);
}
