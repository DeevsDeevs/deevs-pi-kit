import type { ArxivPaper } from "./types.ts";

export function parseArxivFeed(xml: string): { totalResults: number | null; papers: ArxivPaper[] } {
	const totalRaw = textOf(xml, "opensearch:totalResults") ?? textOf(xml, "totalResults");
	const totalResults = totalRaw === null ? null : Number.parseInt(totalRaw, 10);
	const papers = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => parseEntry(match[1]!));
	return { totalResults: Number.isFinite(totalResults) ? totalResults : null, papers };
}

export function buildBibtex(paper: ArxivPaper): string {
	const firstAuthor = paper.authors[0] ?? "arxiv";
	const lastName = firstAuthor.trim().split(/\s+/).at(-1)?.replace(/[^A-Za-z0-9]/g, "") || "arxiv";
	const year = paper.published.slice(0, 4) || paper.updated.slice(0, 4) || "????";
	const key = `${lastName}${year}_${paper.baseId.replace(/[^A-Za-z0-9]/g, "")}`;
	const lines = [
		`@article{${key},`,
		`  title         = {${escapeBibtex(paper.title)}},`,
		`  author        = {${paper.authors.map(escapeBibtex).join(" and ")}},`,
		`  year          = {${year}},`,
		`  eprint        = {${paper.baseId}},`,
		`  archivePrefix = {arXiv},`,
	];
	if (paper.primaryCategory) lines.push(`  primaryClass  = {${paper.primaryCategory}},`);
	if (paper.doi) lines.push(`  doi           = {${paper.doi}},`);
	lines.push(`  url           = {${paper.absUrl}}`);
	lines.push("}");
	return lines.join("\n");
}

function parseEntry(entry: string): ArxivPaper {
	const fullId = normalizeArxivId((textOf(entry, "id") ?? "").split("/abs/").at(-1) ?? "");
	const baseId = fullId.replace(/v\d+$/i, "");
	const version = fullId === baseId ? null : fullId.slice(baseId.length);
	const categories = attrValues(entry, "category", "term");
	const primaryCategory = attrValue(entry, "arxiv:primary_category", "term") ?? categories[0] ?? null;
	return {
		id: fullId,
		version,
		baseId,
		title: clean(textOf(entry, "title") ?? ""),
		authors: [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((match) => clean(decodeXml(match[1]!))).filter(Boolean),
		summary: clean(textOf(entry, "summary") ?? ""),
		published: clean(textOf(entry, "published") ?? ""),
		updated: clean(textOf(entry, "updated") ?? ""),
		categories,
		primaryCategory,
		doi: cleanNullable(textOf(entry, "arxiv:doi")),
		comment: cleanNullable(textOf(entry, "arxiv:comment")),
		journalRef: cleanNullable(textOf(entry, "arxiv:journal_ref")),
		absUrl: `https://arxiv.org/abs/${baseId}`,
		pdfUrl: `https://arxiv.org/pdf/${baseId}`,
	};
}

function textOf(xml: string, tag: string): string | null {
	const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = xml.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`));
	return match ? decodeXml(match[1]!) : null;
}

function attrValues(xml: string, tag: string, attr: string): string[] {
	const values: string[] = [];
	for (const match of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))) {
		const value = attrValue(match[0]!, tag, attr);
		if (value) values.push(value);
	}
	return [...new Set(values)];
}

function attrValue(xml: string, tag: string, attr: string): string | null {
	const tagMatch = xml.match(new RegExp(`<${tag}\\b[^>]*>`));
	const source = tagMatch?.[0] ?? xml;
	const attrMatch = source.match(new RegExp(`${attr}=["']([^"']+)["']`));
	return attrMatch ? decodeXml(attrMatch[1]!) : null;
}

function clean(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function cleanNullable(value: string | null): string | null {
	const cleaned = value === null ? "" : clean(value);
	return cleaned || null;
}

function normalizeArxivId(id: string): string {
	return id.trim().replace(/^arXiv:/i, "");
}

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function escapeBibtex(value: string): string {
	return value.replace(/[{}]/g, "");
}
