import type { ChainListItem, ChainLoadResult, ChainRankedSearchResult, ChainSearchResult } from "./types.ts";

export function formatList(chains: ChainListItem[]): string {
	if (chains.length === 0) return "No chains found in .chains. Use chain_save to create one.";
	return chains.map((chain) => {
		const latest = chain.latest ? `${chain.latest.filename} @ ${chain.latest.branch}${chain.latest.stale ? " (stale)" : ""}` : "none";
		const branches = chain.branches?.length ? `\n  branches: ${chain.branches.map((branch) => `${branch.branch}(${branch.count})`).join(", ")}` : "";
		return `${chain.chain} — ${chain.count} link(s), latest: ${latest}${branches}`;
	}).join("\n");
}

export function formatLoad(result: ChainLoadResult): string {
	const warning = result.link.stale ? `\n[stale: ${result.link.ageDays} days old]` : "";
	const recent = result.recent.map((link) => `- ${link.filename} @ ${link.branch}`).join("\n");
	return [
		`Loaded ${result.link.chain}/${result.link.filename} @ ${result.link.branch}${warning}`,
		`Title: ${result.link.title}`,
		`Parent: ${result.link.parent ?? "(none)"}`,
		`Next step: ${result.link.nextStep ?? "(not found)"}`,
		`Recent:\n${recent}`,
		"Content:",
		result.content,
	].join("\n\n");
}

export function formatSearch(result: ChainSearchResult): string {
	if (result.matches.length === 0) return `No chain matches for: ${result.query}`;
	const mode = result.regex ? "regex" : "text";
	const lines = result.matches.map((match) => [`${match.link.chain}/${match.link.filename}@${match.link.branch}:${match.line}`, match.snippet].join("\n"));
	if (result.truncated) lines.push("[search truncated by maxResults]");
	return [`Search (${mode}): ${result.query}`, ...lines].join("\n\n");
}

export function formatRankedSearch(result: ChainRankedSearchResult): string {
	if (result.matches.length === 0) return `No relevant chain links for: ${result.query}`;
	const lines = result.matches.map((match, index) => [
		`${index + 1}. ${match.link.chain}/${match.link.filename}@${match.link.branch} score=${match.score.toFixed(3)} lexical=${match.lexicalScore.toFixed(3)} recency=${match.recencyScore.toFixed(3)}`,
		`Title: ${match.link.title}`,
		match.link.nextStep ? `Next: ${match.link.nextStep}` : "",
		`Terms: ${match.matchedTerms.join(", ")}`,
		match.snippet,
	].filter(Boolean).join("\n"));
	if (result.truncated) lines.push("[lookup truncated by maxResults]");
	return [`Lookup: ${result.query}`, ...lines].join("\n\n");
}
