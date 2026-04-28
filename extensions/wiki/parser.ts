import { basename, dirname, extname, posix } from "node:path";

export interface WikiMetadata {
	title?: string;
	type?: string;
	tags: string[];
	sources: string[];
	confidence?: string;
	contested: boolean;
	sha256?: string;
}

export interface WikiLinkRef {
	raw: string;
	target: string;
	line: number;
	embed: boolean;
	local: boolean;
	asset: boolean;
}

export function stripFrontmatter(content: string): string {
	return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

export function frontmatterBody(content: string): string {
	const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content);
	return match?.[1] ?? "";
}

export function parseMetadata(content: string): WikiMetadata {
	const body = frontmatterBody(content);
	const metadata: WikiMetadata = { tags: [], sources: [], contested: false };
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		const pair = /^(title|type|tags|sources|confidence|contested|sha256):\s*(.*)$/.exec(line);
		if (!pair) continue;
		const key = pair[1]!;
		const value = unquote(pair[2]!.trim());
		if (key === "title") metadata.title = value;
		else if (key === "type") metadata.type = value;
		else if (key === "tags") metadata.tags = parseList(value);
		else if (key === "sources") metadata.sources = parseList(value);
		else if (key === "confidence") metadata.confidence = value;
		else if (key === "contested") metadata.contested = /^(true|yes|1)$/i.test(value);
		else if (key === "sha256") metadata.sha256 = value;
	}
	return metadata;
}

export function extractTitle(content: string, relativePath: string): string {
	const metadata = parseMetadata(content);
	if (metadata.title) return metadata.title;
	const heading = /^#\s+(.+)$/m.exec(stripFrontmatter(content))?.[1]?.trim();
	return heading || basename(relativePath, extname(relativePath));
}

export function stripCodeFences(content: string): string {
	return content.replace(/```[\s\S]*?```/g, (block) => "\n".repeat(block.split(/\r?\n/).length - 1));
}

export function parseWikiLinks(content: string): WikiLinkRef[] {
	const body = stripCodeFences(stripFrontmatter(content));
	const links: WikiLinkRef[] = [];
	const regex = /(!?)\[\[([^\]\n]+)\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(body))) {
		const raw = match[0]!;
		const embed = match[1] === "!";
		const inner = match[2]!.split("|")[0]!.trim();
		const withoutHeading = inner.split("#")[0]!.trim();
		const local = inner.startsWith("#") || withoutHeading.length === 0;
		const asset = isAssetTarget(withoutHeading);
		links.push({ raw, target: normalizeTarget(withoutHeading), line: lineNumberAt(body, match.index), embed, local, asset });
	}
	return links;
}

export function pageId(relativePath: string): string {
	return normalizeTarget(relativePath.replace(/\.md$/i, ""));
}

export function basenameId(relativePath: string): string {
	return basename(pageId(relativePath));
}

export function sameDirCandidate(fromId: string, target: string): string {
	return normalizeTarget(posix.join(dirname(fromId), target));
}

export function normalizeTarget(value: string): string {
	return value
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.md$/i, "")
		.split("/")
		.filter(Boolean)
		.join("/");
}

export function parseTaxonomyTags(schemaContent: string): Set<string> | null {
	const section = /##\s+Tag Taxonomy\s*\n([\s\S]*?)(?=^##\s+|\s*$)/im.exec(schemaContent)?.[1];
	if (!section) return null;
	const tags = new Set<string>();
	for (const line of section.split(/\r?\n/)) {
		const match = /^\s*-\s*`?([a-zA-Z0-9_-]+)`?\s*(?::|—|-|$)/.exec(line);
		if (match) tags.add(match[1]!);
	}
	return tags.size ? tags : null;
}

function parseList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	const body = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return body.split(",").map((item) => unquote(item.trim())).filter(Boolean);
}

function unquote(value: string): string {
	return value.replace(/^['\"]|['\"]$/g, "");
}

function lineNumberAt(content: string, index: number): number {
	return content.slice(0, index).split(/\r?\n/).length;
}

function isAssetTarget(target: string): boolean {
	const extension = extname(target).toLowerCase();
	return !!extension && extension !== ".md";
}
