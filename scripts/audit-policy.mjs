const ADVISORY = "https://github.com/advisories/GHSA-mh99-v99m-4gvg";
const NODE = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
export const EXCEPTION_EXPIRES = Date.parse("2026-08-15T00:00:00Z");

export function acceptsKnownPiBraceAdvisory(vulnerabilities, installedVersion, now = Date.now()) {
	if (now >= EXCEPTION_EXPIRES || installedVersion !== "5.0.7" || vulnerabilities.length !== 1) return false;
	const item = vulnerabilities[0];
	return item?.name === "brace-expansion"
		&& item.severity === "high"
		&& item.isDirect === false
		&& item.nodes?.length === 1 && item.nodes[0] === NODE
		&& item.via?.length === 1 && typeof item.via[0] === "object" && item.via[0].url === ADVISORY;
}
