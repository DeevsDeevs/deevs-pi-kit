import { readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** durable's portable SqliteStorage over Bun's synchronous `bun:sqlite`; every operation is queued behind the last. */
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
		const next = tail.then(op);
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

/** `engine.lock` with `{pid, identity}`; a lock whose process identity no longer matches is stale. */
export async function lock(file: string): Promise<void> {
	const mine = JSON.stringify({ pid: process.pid, identity: await readProcessIdentity(process.pid) });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await writeFile(file, mine, { flag: "wx" });
			return;
		} catch (error) {
			// SAFETY: fs/promises rejects with a Node system error.
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
		const value = JSON.parse(text);
		return Value.Check(LockFile, value) ? value : undefined;
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
