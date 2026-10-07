// Inside a bench container only: copies the polygon's logins from the read-only volume at /login into this
// container's own HOME, refresh tokens replaced by placeholders, so a run can never rotate or log out the volume.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILES = [".claude/.credentials.json", ".pi/agent/auth.json", ".codex/auth.json"];
const REFRESH = new Set(["refresh", "refreshToken", "refresh_token"]);
const dead = (v) => Array.isArray(v) ? v.map(dead)
	: v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REFRESH.has(k) && typeof x === "string" ? "bench-invalid-refresh-token" : dead(x)]))
	: v;

export function stageLogins(home, from = "/login") {
	const staged = [];
	for (const f of FILES) {
		if (!existsSync(join(from, f))) continue;
		mkdirSync(dirname(join(home, f)), { recursive: true });
		writeFileSync(join(home, f), JSON.stringify(dead(JSON.parse(readFileSync(join(from, f), "utf8"))), null, 2), { mode: 0o600 });
		staged.push(f);
	}
	return staged;
}

/** Access-token expiry per login, epoch ms; a run cannot refresh, so its token must outlive it. */
export function expiries(from = "/login") {
	const read = (f) => { try { return JSON.parse(readFileSync(join(from, f), "utf8")); } catch { return undefined; } };
	const pi = read(".pi/agent/auth.json") ?? {};
	return { claude: read(".claude/.credentials.json")?.claudeAiOauth?.expiresAt, ...Object.fromEntries(Object.entries(pi).map(([k, v]) => [`pi:${k}`, v.expires])) };
}
