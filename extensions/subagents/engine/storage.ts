import { existsSync } from "node:fs";
import { link, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ownsProcessIdentity, readProcessIdentity, trySignalGroup } from "../../shared/process-group.ts";

type Row = Record<string, SqliteValue>;
interface BunDatabase {
	exec(sql: string): void;
	query(sql: string): { run(...params: SqliteValue[]): void; get(...params: SqliteValue[]): Row | null; all(...params: SqliteValue[]): Row[] };
	close(): void;
}

const LockFile = Type.Object({ pid: Type.Number(), identity: Type.Optional(Type.String()) });
const KEEP_MS = 14 * 86_400_000;
/** Written at close when nothing in the store is running or paused and its Outbox is empty; removed at open. */
export const SETTLED = "settled";

/** durable's SqliteStorage over Bun's synchronous `bun:sqlite`; each operation waits for the last, then a macrotask, so a burst of commits never starves timers. */
export function bunSqlite(Database: new (path: string, options: { create: boolean }) => BunDatabase, path: string): SqliteDatabase {
	const db = new Database(path, { create: true });
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
	const direct: SqliteExecutor = {
		exec: async (sql) => void db.exec(sql),
		run: async (sql, ...params) => void db.query(sql).run(...params),
		// SAFETY: durable's own SQL selects exactly the columns of the row type it asks for.
		get: async <T extends object>(sql: string, ...params: SqliteValue[]) => (db.query(sql).get(...params) ?? undefined) as T | undefined,
		// SAFETY: as for get.
		all: async <T extends object>(sql: string, ...params: SqliteValue[]) => db.query(sql).all(...params) as T[],
	};
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(op: () => Promise<T>): Promise<T> => {
		const next = tail.then(() => new Promise((resolve) => setImmediate(resolve))).then(op);
		tail = next.catch(() => {});
		return next;
	};
	return {
		exec: (sql) => serial(() => direct.exec(sql)),
		run: (sql, ...params) => serial(() => direct.run(sql, ...params)),
		get: (sql, ...params) => serial(() => direct.get(sql, ...params)),
		all: (sql, ...params) => serial(() => direct.all(sql, ...params)),
		transaction: (callback) => serial(async () => {
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

/**
 * `engine.lock` with `{pid, identity}`; a lock whose process identity no longer matches is stale. The lock is linked in
 * whole, so another Pi never reads it empty.
 */
export async function lock(file: string): Promise<void> {
	const mine = `${file}.${process.pid}`;
	await writeFile(mine, JSON.stringify({ pid: process.pid, identity: await readProcessIdentity(process.pid) }));
	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await link(mine, file);
				return;
			} catch (error) {
				// SAFETY: fs/promises rejects with a Node system error.
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const holder = await heldBy(file);
			if (holder !== undefined && holder !== process.pid) throw new Error(`This session's agents are held by Pi process ${holder}; close it or open another session.`);
			// ponytail: two Pis that find the same stale lock at once can both take it; a rename-then-check would close that.
			await rm(file, { force: true });
		}
		throw new Error(`Could not take ${file}.`);
	} finally {
		await rm(mine, { force: true });
	}
}

export async function unlock(file: string): Promise<void> {
	const held = parseLock(await readFile(file, "utf8").catch(() => ""));
	if (held?.pid === process.pid) await rm(file, { force: true });
}

/** The live process that holds the lock, if any. */
async function heldBy(file: string): Promise<number | undefined> {
	const held = parseLock(await readFile(file, "utf8").catch(() => ""));
	return held && await ownsProcessIdentity(held.pid, held.identity) ? held.pid : undefined;
}

/**
 * At engine open: removes the engine stores (their transcripts, `out/` logs and `cli/` folders) that closed settled, are held
 * by no Pi and were untouched for 14 days; the workflow runs as old that ended (their `<runId>.json` is written), and old saved
 * scripts. A store or run that Pi left running or paused stays, however old. `kitDir` is `<agentDir>/pi-kit`.
 */
export async function prune(kitDir: string, now = Date.now()): Promise<void> {
	const under = async (dir: string) => (await readdir(dir).catch(() => [])).map((name) => join(dir, name));
	const below = async (dir: string) => (await Promise.all((await under(dir)).map(under))).flat();
	const old = async (path: string) => ((await stat(path).catch(() => undefined))?.mtimeMs ?? now) < now - KEEP_MS;
	for (const store of await below(join(kitDir, "agents"))) {
		if (existsSync(join(store, SETTLED)) && await old(store) && await heldBy(join(store, "engine.lock")) === undefined) await rm(store, { recursive: true, force: true });
	}
	const workflows = await below(join(kitDir, "workflows"));
	const scripts = (await Promise.all(workflows.filter((path) => basename(path) === "scripts").map(under))).flat();
	const ended = workflows.filter((path) => basename(path) !== "scripts" && existsSync(join(path, `${basename(path)}.json`)));
	for (const path of [...ended, ...scripts]) {
		if (await old(path)) await rm(path, { recursive: true, force: true });
	}
}

function parseLock(text: string): { pid: number; identity?: string } | undefined {
	try {
		const value = JSON.parse(text);
		return Value.Check(LockFile, value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Kills every process, and its group, whose environment holds `marker` (`PI_KIT_OWNER=<dir>`, `PI_KIT_WORKER=<agentId>`). */
export async function reap(marker: string): Promise<number> {
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
