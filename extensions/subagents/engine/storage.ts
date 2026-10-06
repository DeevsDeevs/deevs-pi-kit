import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { ownsProcessIdentity, readProcessIdentity, trySignalGroup } from "../../shared/process-group.ts";

type Row = Record<string, unknown>;
interface BunDatabase {
	exec(sql: string): void;
	query(sql: string): { run(...params: unknown[]): void; get(...params: unknown[]): Row | null; all(...params: unknown[]): Row[] };
	close(): void;
}

/** durable's portable SqliteStorage over Bun's synchronous `bun:sqlite`; every operation is queued behind the last. */
export function bunSqlite(Database: new (path: string, options: { create: boolean }) => BunDatabase, path: string) {
	const db = new Database(path, { create: true });
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
	const direct = {
		exec: async (sql: string) => void db.exec(sql),
		run: async (sql: string, ...params: unknown[]) => void db.query(sql).run(...params),
		get: async (sql: string, ...params: unknown[]) => db.query(sql).get(...params) ?? undefined,
		all: async (sql: string, ...params: unknown[]) => db.query(sql).all(...params),
	};
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(op: () => Promise<T>): Promise<T> => {
		const next = tail.then(op);
		tail = next.catch(() => {});
		return next;
	};
	return {
		exec: (sql: string) => serial(() => direct.exec(sql)),
		run: (sql: string, ...params: unknown[]) => serial(() => direct.run(sql, ...params)),
		get: (sql: string, ...params: unknown[]) => serial(() => direct.get(sql, ...params)),
		all: (sql: string, ...params: unknown[]) => serial(() => direct.all(sql, ...params)),
		transaction: <T>(callback: (tx: typeof direct) => Promise<T>) => serial(async () => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = await callback(direct);
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}),
		close: () => serial(async () => db.close()),
	};
}

/** `engine.lock` with `{pid, identity}`; a lock whose process identity no longer matches is stale. */
export async function lock(file: string): Promise<void> {
	const mine = JSON.stringify({ pid: process.pid, identity: await readProcessIdentity(process.pid) });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await writeFile(file, mine, { flag: "wx" });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const held = parseLock(await readFile(file, "utf8").catch(() => ""));
		if (held && held.pid !== process.pid && await ownsProcessIdentity(held.pid, held.identity)) {
			throw new Error(`This session's agents are held by Pi process ${held.pid}; close it or open another session.`);
		}
		await rm(file, { force: true });
	}
	throw new Error(`Could not take ${file}.`);
}

export async function unlock(file: string): Promise<void> {
	const held = parseLock(await readFile(file, "utf8").catch(() => ""));
	if (held?.pid === process.pid) await rm(file, { force: true });
}

function parseLock(text: string): { pid: number; identity?: string } | undefined {
	try {
		const value = JSON.parse(text) as { pid?: unknown; identity?: unknown };
		return typeof value.pid === "number" ? { pid: value.pid, identity: typeof value.identity === "string" ? value.identity : undefined } : undefined;
	} catch {
		return undefined;
	}
}

/** Kills every process group whose members carry `PI_KIT_OWNER=<owner>`: tool children orphaned by a crash or a quit. */
export async function reap(owner: string): Promise<number> {
	const marker = `PI_KIT_OWNER=${owner}`;
	const ownGroup = await processGroup(process.pid);
	const groups = new Set<number>();
	const pids: number[] = [];
	for (const name of await readdir("/proc").catch(() => [])) {
		const pid = Number(name);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
		if (!environ.split("\0").includes(marker)) continue;
		pids.push(pid);
		const group = await processGroup(pid);
		if (group && group !== ownGroup) groups.add(group);
	}
	for (const group of groups) trySignalGroup(group, "SIGKILL");
	for (const pid of pids) {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
	return pids.length;
}

async function processGroup(pid: number): Promise<number | undefined> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
	const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
	return Number.isInteger(group) && group > 0 ? group : undefined;
}
