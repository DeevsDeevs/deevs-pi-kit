import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { HOSTED_STATE_MAX_BYTES } from "../../schemas/common.ts";
import type { HostedRuntimeInstance, HostedRuntimeState } from "../../schemas/state.ts";
import type { HostedStateOperation } from "./operations.ts";
import { isNodeError } from "../../errors.ts";
import { schemaError } from "../../schemas/common.ts";
import {
	HOSTED_STATE_VERSION,
	HostedRuntimeInstanceSchema,
	HostedRuntimeStateSchema,
	emptyHostedRuntimeState,
} from "../../schemas/state.ts";
import { HostedStateStorageError, storageError } from "./errors.ts";
import { checkStateIntegrity } from "./integrity.ts";
import { reduceHostedState } from "./reduce.ts";

type PersistedStateValue = string | number | boolean | null | PersistedStateValue[] | { [field: string]: PersistedStateValue };

const INSTANCE_MAX_BYTES = 4 * 1024;
const PersistedStateVersion = Type.Object({ version: Type.Integer() });

interface RuntimeStatePaths {
	instance: string;
	state: string;
}

export class HostedStateStore {
	readonly root: string;
	private state: HostedRuntimeState;
	private uncertain = false;

	constructor(root: string) {
		this.root = root;
		this.state = readHostedRuntimeState(root);
		// A process restart alone does not flush a previously uncertain rename.
		try {
			const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
			try { fsyncSync(directory); } finally { closeSync(directory); }
		} catch (error) { throw storageError("Cannot confirm recovered runtime storage", error, true); }
	}

	read(): HostedRuntimeState {
		if (this.uncertain) {
			throw new HostedStateStorageError("Runtime storage outcome is uncertain; restart and recover before reading or mutating state.", true);
		}
		return this.state;
	}

	apply(operation: HostedStateOperation): HostedRuntimeState {
		const next = reduceHostedState(this.read(), operation);
		if (next === this.state) return this.state;
		try { writeHostedRuntimeState(this.root, next); }
		catch (error) {
			if (error instanceof HostedStateStorageError && error.uncertain) this.uncertain = true;
			throw error;
		}
		this.state = next;
		return next;
	}
}

export function runtimeStatePaths(root: string): RuntimeStatePaths {
	return { instance: join(root, "instance.json"), state: join(root, "state.v1.json") };
}

export function loadOrCreateRuntimeInstance(root: string, createId: () => string = () => `rt_${randomUUID()}`): HostedRuntimeInstance {
	prepareRoot(root);
	const path = runtimeStatePaths(root).instance;
	const existing = readJson(path, INSTANCE_MAX_BYTES);
	if (existing !== undefined) {
		if (!Value.Check(HostedRuntimeInstanceSchema, existing)) {
			throw storageError("Runtime instance is malformed", schemaError(HostedRuntimeInstanceSchema, existing, "Runtime instance"));
		}
		return existing;
	}
	const instance: HostedRuntimeInstance = { version: 1, runtimeId: createId() };
	writeAtomicJson(root, path, instance, INSTANCE_MAX_BYTES);
	return instance;
}

export function readHostedRuntimeState(root: string): HostedRuntimeState {
	prepareRoot(root);
	const path = runtimeStatePaths(root).state;
	const value = readJson(path, HOSTED_STATE_MAX_BYTES);
	if (value === undefined) return emptyHostedRuntimeState();
	// State is current-only: another version is discarded, never migrated and never a permanent load failure.
	if (Value.Check(PersistedStateVersion, value) && value.version !== HOSTED_STATE_VERSION) return discardSupersededState(path);
	return validateHostedRuntimeState(value);
}

function discardSupersededState(path: string): HostedRuntimeState {
	try { renameSync(path, `${path}.superseded`); }
	catch (error) { throw storageError(`Cannot discard superseded runtime state: ${path}`, error); }
	return emptyHostedRuntimeState();
}

export function validateHostedRuntimeState<Source>(value: Source): HostedRuntimeState {
	try {
		if (!Value.Check(HostedRuntimeStateSchema, value)) throw schemaError(HostedRuntimeStateSchema, value, "Runtime state");
		checkStateIntegrity(value);
		return value;
	} catch (error) {
		throw storageError("Runtime state is malformed", error);
	}
}

/** The socket proves request params and the load proves the store; a reducer's own output is trusted. */
export function writeHostedRuntimeState(root: string, state: HostedRuntimeState): void {
	prepareRoot(root);
	writeAtomicJson(root, runtimeStatePaths(root).state, state, HOSTED_STATE_MAX_BYTES);
}

function prepareRoot(root: string): void {
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const info = lstatSync(root);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("runtime root is not a real directory");
		chmodSync(root, 0o700);
	} catch (error) {
		throw storageError(`Cannot prepare runtime directory: ${root}`, error);
	}
}

function readJson(path: string, maxBytes: number): PersistedStateValue | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const info = fstatSync(fd);
		if (!info.isFile()) throw new Error("state path is not a regular file");
		if (info.size > maxBytes) throw new Error(`state exceeds ${maxBytes} bytes`);
		return JSON.parse(readFileSync(fd, "utf8"));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw storageError(`Cannot read runtime state: ${path}`, error);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeAtomicJson(root: string, path: string, value: HostedRuntimeState | HostedRuntimeInstance, maxBytes: number): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content) > maxBytes) throw new HostedStateStorageError(`Runtime state exceeds ${maxBytes} bytes.`);
	const temporary = join(root, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	let renamed = false;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		renamed = true;
		chmodSync(path, 0o600);
		const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { fsyncSync(directory); } finally { closeSync(directory); }
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch {}
		throw storageError(`Cannot persist runtime state: ${path}`, error, renamed);
	}
}
