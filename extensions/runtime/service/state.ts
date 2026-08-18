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
import {
	HOSTED_MAX_DELIVERY_BATCH,
	HOSTED_MONITOR_MAX_ENTRIES,
	HOSTED_STATE_MAX_BYTES,
	type HostedClaim,
	type HostedEvent,
	type HostedEventDelivery,
	type HostedFileObservation,
	type HostedMonitor,
	type HostedRuntimeInstance,
	type HostedRuntimeState,
	type HostedStateOperation,
	type HostedTarget,
	type HostedWake,
} from "../hosted-types.ts";

const MAX_ID_BYTES = 200;
const MAX_PATH_BYTES = 8 * 1024;
const MAX_SUMMARY_BYTES = 2 * 1024;
const MAX_STATE_RECORDS = 10_000;
const INSTANCE_MAX_BYTES = 4 * 1024;

export class HostedStateStorageError extends Error {
	readonly code = "storage_error" as const;
}

export class HostedStateConflictError extends Error {
	readonly code: "conflict" | "claim_conflict";

	constructor(code: "conflict" | "claim_conflict", message: string) {
		super(message);
		this.code = code;
	}
}

export function emptyHostedRuntimeState(): HostedRuntimeState {
	return { version: 1, targets: {}, monitors: {}, events: {}, dedupe: {}, claims: {}, wakes: {} };
}

export class HostedStateStore {
	readonly root: string;
	private state: HostedRuntimeState;

	constructor(root: string) {
		this.root = root;
		this.state = readHostedRuntimeState(root);
	}

	read(): HostedRuntimeState {
		return this.state;
	}

	apply(operation: HostedStateOperation): HostedRuntimeState {
		const next = reduceHostedState(this.state, operation);
		if (next === this.state) return this.state;
		writeHostedRuntimeState(this.root, next);
		this.state = next;
		return next;
	}
}

export function reduceHostedState(state: HostedRuntimeState, operation: HostedStateOperation): HostedRuntimeState {
	if (operation.type === "target.ensure") {
		const existing = state.targets[operation.target.targetKey];
		if (existing) {
			if (!sameTarget(existing, operation.target)) throw new HostedStateConflictError("conflict", "Target identity does not match its durable key.");
			return state;
		}
		return { ...state, targets: { ...state.targets, [operation.target.targetKey]: operation.target } };
	}

	if (operation.type === "monitor.create") {
		const monitor = operation.monitor;
		if (!state.targets[monitor.targetKey] || Object.keys(monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
		const existingId = state.monitors[monitor.monitorId];
		if (existingId && !sameMonitorIdentity(existingId, monitor)) throw new HostedStateConflictError("conflict", "Monitor ID already belongs to another monitor.");
		const existingTarget = Object.values(state.monitors).find((candidate) => candidate.targetKey === monitor.targetKey);
		if (existingTarget) {
			if (existingTarget.directory !== monitor.directory) throw new HostedStateConflictError("conflict", "Target already owns another monitor.");
			return state;
		}
		return { ...state, monitors: { ...state.monitors, [monitor.monitorId]: monitor } };
	}

	if (operation.type === "monitor.delete") {
		const monitor = state.monitors[operation.monitorId];
		if (!monitor || monitor.targetKey !== operation.targetKey) return state;
		const monitors = { ...state.monitors };
		delete monitors[operation.monitorId];
		return { ...state, monitors };
	}

	if (operation.type === "monitor.commit") {
		const current = state.monitors[operation.monitor.monitorId];
		if (!current || !sameMonitorIdentity(current, operation.monitor)) return state;
		if (operation.monitor.createdAt !== current.createdAt || operation.monitor.sequence < current.sequence || operation.monitor.updatedAt < current.updatedAt) return state;
		if (Object.keys(operation.monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
		if (operation.events.some((event) => !validMonitorEvent(operation.monitor, event) || event.source.sequence <= current.sequence || event.source.sequence > operation.monitor.sequence)) return state;
		let changed = current !== operation.monitor;
		const events = { ...state.events };
		const dedupe = { ...state.dedupe };
		for (const event of operation.events) {
			if (events[event.eventId] || dedupe[event.dedupeKey]) continue;
			events[event.eventId] = event;
			dedupe[event.dedupeKey] = event.eventId;
			changed = true;
		}
		if (!changed) return state;
		return {
			...state,
			monitors: { ...state.monitors, [operation.monitor.monitorId]: operation.monitor },
			events,
			dedupe,
		};
	}

	if (operation.type === "inbox.claim") {
		const claim = operation.claim;
		const existing = state.claims[claim.claimId];
		if (existing) {
			if (!sameClaim(existing, claim)) throw new HostedStateConflictError("claim_conflict", "Claim ID does not match its durable receipt.");
			return state;
		}
		if (claim.status !== "active" || claim.eventIds.length < 1 || claim.eventIds.length > HOSTED_MAX_DELIVERY_BATCH) return state;
		if (new Set(claim.eventIds).size !== claim.eventIds.length || claim.leaseUntil <= claim.createdAt) return state;
		const claimedEvents = claim.eventIds.map((eventId) => state.events[eventId]);
		if (claimedEvents.some((event) => !event || event.targetKey !== claim.targetKey || event.delivery.status !== "pending")) return state;
		const events = { ...state.events };
		for (const event of claimedEvents as HostedEvent[]) events[event.eventId] = { ...event, delivery: { status: "claimed", claimId: claim.claimId } };
		return { ...state, claims: { ...state.claims, [claim.claimId]: claim }, events };
	}

	if (operation.type === "inbox.ack") {
		const claim = state.claims[operation.claimId];
		if (!claim || claim.targetKey !== operation.targetKey || !sameIds(claim.eventIds, operation.eventIds)) return state;
		if (claim.status === "acked") return state;
		const events = { ...state.events };
		for (const eventId of claim.eventIds) {
			const event = events[eventId];
			if (!event || event.targetKey !== claim.targetKey) return state;
			if (event.delivery.status !== "acked") events[eventId] = { ...event, delivery: { status: "acked", claimId: claim.claimId, ackedAt: operation.at } };
		}
		return {
			...state,
			claims: { ...state.claims, [claim.claimId]: { ...claim, status: "acked", settledAt: operation.at } },
			events,
		};
	}

	if (operation.type === "inbox.release") return releaseClaim(state, operation.targetKey, operation.claimId, operation.eventIds, operation.at);

	if (operation.type === "inbox.release_expired") {
		let next = state;
		for (const claim of Object.values(state.claims)) {
			if (claim.status === "active" && claim.leaseUntil <= operation.at) next = releaseClaim(next, claim.targetKey, claim.claimId, claim.eventIds, operation.at);
		}
		return next;
	}

	if (operation.type === "retention.prune") return pruneAcknowledged(state, operation.before);

	if (operation.type === "wake.set") {
		if (!state.targets[operation.wake.targetKey]) return state;
		const existing = state.wakes[operation.wake.targetKey];
		if (existing) return state;
		return { ...state, wakes: { ...state.wakes, [operation.wake.targetKey]: operation.wake } };
	}

	if (operation.type === "wake.clear") {
		const wake = state.wakes[operation.targetKey];
		if (!wake || wake.wakeId !== operation.wakeId) return state;
		const wakes = { ...state.wakes };
		delete wakes[operation.targetKey];
		return { ...state, wakes };
	}

	return state;
}

export function pendingHostedEvents(state: HostedRuntimeState, targetKey: string): HostedEvent[] {
	return Object.values(state.events)
		.filter((event) => event.targetKey === targetKey && event.delivery.status === "pending")
		.sort((a, b) => a.source.sequence - b.source.sequence || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId));
}

export function runtimeStatePaths(root: string): { instance: string; state: string } {
	return { instance: join(root, "instance.json"), state: join(root, "state.v1.json") };
}

export function loadOrCreateRuntimeInstance(root: string, createId: () => string = () => `rt_${randomUUID()}`): HostedRuntimeInstance {
	prepareRoot(root);
	const path = runtimeStatePaths(root).instance;
	const existing = readJson(path, INSTANCE_MAX_BYTES);
	if (existing !== undefined) return validateInstance(existing);
	const instance: HostedRuntimeInstance = { version: 1, runtimeId: createId() };
	writeAtomicJson(root, path, instance, INSTANCE_MAX_BYTES);
	return instance;
}

export function readHostedRuntimeState(root: string): HostedRuntimeState {
	prepareRoot(root);
	const value = readJson(runtimeStatePaths(root).state, HOSTED_STATE_MAX_BYTES);
	return value === undefined ? emptyHostedRuntimeState() : validateHostedRuntimeState(value);
}

export function writeHostedRuntimeState(root: string, state: HostedRuntimeState): void {
	prepareRoot(root);
	writeAtomicJson(root, runtimeStatePaths(root).state, validateHostedRuntimeState(state), HOSTED_STATE_MAX_BYTES);
}

export function validateHostedRuntimeState(value: unknown): HostedRuntimeState {
	try {
		const state = strictObject(value, "runtime state", ["version", "targets", "monitors", "events", "dedupe", "claims", "wakes"]);
		if (state.version !== 1) throw new Error("unsupported runtime state version");
		const targets = mapValues(state.targets, "targets", validateTarget);
		const monitors = mapValues(state.monitors, "monitors", validateMonitor);
		const events = mapValues(state.events, "events", validateEvent);
		const dedupe = mapStrings(state.dedupe, "dedupe");
		const claims = mapValues(state.claims, "claims", validateClaim);
		const wakes = mapValues(state.wakes, "wakes", validateWake);
		const result: HostedRuntimeState = { version: 1, targets, monitors, events, dedupe, claims, wakes };
		validateReferences(result);
		return result;
	} catch (error) {
		throw storageError("Runtime state is malformed", error);
	}
}

function releaseClaim(state: HostedRuntimeState, targetKey: string, claimId: string, eventIds: string[], at: number): HostedRuntimeState {
	const claim = state.claims[claimId];
	if (!claim || claim.targetKey !== targetKey || !sameIds(claim.eventIds, eventIds) || claim.status !== "active") return state;
	const events = { ...state.events };
	for (const eventId of claim.eventIds) {
		const event = events[eventId];
		if (event?.delivery.status === "claimed" && event.delivery.claimId === claimId) {
			events[eventId] = { ...event, delivery: { status: "pending", latestClaimId: claimId } };
		}
	}
	return {
		...state,
		claims: { ...state.claims, [claimId]: { ...claim, status: "released", settledAt: at } },
		events,
	};
}

function pruneAcknowledged(state: HostedRuntimeState, before: number): HostedRuntimeState {
	const removable = new Set(Object.values(state.events)
		.filter((event) => event.delivery.status === "acked" && event.delivery.ackedAt < before)
		.map((event) => event.eventId));
	let changed = true;
	while (changed) {
		changed = false;
		for (const claim of Object.values(state.claims)) {
			const count = claim.eventIds.filter((eventId) => removable.has(eventId)).length;
			if (count === 0 || (count === claim.eventIds.length && claim.status !== "active")) continue;
			for (const eventId of claim.eventIds) if (removable.delete(eventId)) changed = true;
		}
	}
	if (removable.size === 0) return state;
	const events = { ...state.events };
	const dedupe = { ...state.dedupe };
	for (const eventId of removable) {
		const event = events[eventId];
		if (!event) continue;
		delete dedupe[event.dedupeKey];
		delete events[eventId];
	}
	const claims = { ...state.claims };
	for (const claim of Object.values(state.claims)) if (claim.eventIds.every((eventId) => removable.has(eventId))) delete claims[claim.claimId];
	return { ...state, events, dedupe, claims };
}

function validMonitorEvent(monitor: HostedMonitor, event: HostedEvent): boolean {
	return event.version === 1
		&& event.targetKey === monitor.targetKey
		&& event.source.kind === "monitor"
		&& event.source.id === monitor.monitorId
		&& event.source.generation === monitor.generation
		&& event.delivery.status === "pending";
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

function readJson(path: string, maxBytes: number): unknown | undefined {
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

function writeAtomicJson(root: string, path: string, value: unknown, maxBytes: number): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(content) > maxBytes) throw new HostedStateStorageError(`Runtime state exceeds ${maxBytes} bytes.`);
	const temporary = join(root, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeFileSync(fd, content, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		const directory = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
		try { fsyncSync(directory); } finally { closeSync(directory); }
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try { unlinkSync(temporary); } catch {}
		throw storageError(`Cannot persist runtime state: ${path}`, error);
	}
}

function validateInstance(value: unknown): HostedRuntimeInstance {
	try {
		const instance = strictObject(value, "runtime instance", ["version", "runtimeId"]);
		if (instance.version !== 1) throw new Error("unsupported runtime instance version");
		return { version: 1, runtimeId: text(instance.runtimeId, "runtime id", MAX_ID_BYTES) };
	} catch (error) {
		throw storageError("Runtime instance is malformed", error);
	}
}

function validateTarget(value: unknown, key: string): HostedTarget {
	const target = strictObject(value, "target", ["targetKey", "projectRoot", "piSessionId", "piSessionFile", "createdAt"]);
	const result: HostedTarget = {
		targetKey: text(target.targetKey, "target key", MAX_ID_BYTES),
		projectRoot: text(target.projectRoot, "project root", MAX_PATH_BYTES),
		piSessionId: text(target.piSessionId, "Pi session id", MAX_ID_BYTES),
		piSessionFile: text(target.piSessionFile, "Pi session file", MAX_PATH_BYTES),
		createdAt: nonNegativeNumber(target.createdAt, "target creation time"),
	};
	if (result.targetKey !== key) throw new Error("target key does not match map key");
	return result;
}

function validateMonitor(value: unknown, key: string): HostedMonitor {
	const monitor = strictObject(value, "monitor", ["monitorId", "targetKey", "generation", "directory", "settleMs", "status", "sequence", "entries", "createdAt", "updatedAt"]);
	const status = monitor.status;
	if (status !== "watching" && status !== "degraded") throw new Error("invalid monitor status");
	const result: HostedMonitor = {
		monitorId: text(monitor.monitorId, "monitor id", MAX_ID_BYTES),
		targetKey: text(monitor.targetKey, "target key", MAX_ID_BYTES),
		generation: text(monitor.generation, "monitor generation", MAX_ID_BYTES),
		directory: text(monitor.directory, "monitor directory", MAX_PATH_BYTES),
		settleMs: integer(monitor.settleMs, "settle milliseconds"),
		status,
		sequence: integer(monitor.sequence, "monitor sequence"),
		entries: mapValues(monitor.entries, "monitor entries", validateObservation, HOSTED_MONITOR_MAX_ENTRIES),
		createdAt: nonNegativeNumber(monitor.createdAt, "monitor creation time"),
		updatedAt: nonNegativeNumber(monitor.updatedAt, "monitor update time"),
	};
	if (result.monitorId !== key) throw new Error("monitor id does not match map key");
	return result;
}

function validateObservation(value: unknown, key: string): HostedFileObservation {
	const entry = strictObject(value, "file observation", ["relativePath", "size", "mtimeMs", "stableSince", "present", "emitted"]);
	const result: HostedFileObservation = {
		relativePath: text(entry.relativePath, "relative path", MAX_PATH_BYTES),
		size: integer(entry.size, "file size"),
		mtimeMs: nonNegativeNumber(entry.mtimeMs, "file modification time"),
		stableSince: nonNegativeNumber(entry.stableSince, "stable since"),
		present: boolean(entry.present, "present"),
		emitted: boolean(entry.emitted, "emitted"),
	};
	if (result.relativePath !== key) throw new Error("relative path does not match map key");
	return result;
}

function validateEvent(value: unknown, key: string): HostedEvent {
	const event = strictObject(value, "hosted event", ["version", "eventId", "dedupeKey", "source", "targetKey", "type", "createdAt", "summary", "payload", "delivery"]);
	if (event.version !== 1 || event.type !== "filesystem.created") throw new Error("invalid hosted event version or type");
	const source = strictObject(event.source, "event source", ["kind", "id", "generation", "sequence"]);
	if (source.kind !== "monitor") throw new Error("invalid event source kind");
	const payload = strictObject(event.payload, "event payload", ["relativePath", "path", "fileType", "size", "mtimeMs"]);
	if (payload.fileType !== "regular") throw new Error("invalid event file type");
	const result: HostedEvent = {
		version: 1,
		eventId: text(event.eventId, "event id", MAX_ID_BYTES),
		dedupeKey: text(event.dedupeKey, "event dedupe key", MAX_PATH_BYTES),
		source: {
			kind: "monitor",
			id: text(source.id, "source id", MAX_ID_BYTES),
			generation: text(source.generation, "source generation", MAX_ID_BYTES),
			sequence: integer(source.sequence, "source sequence"),
		},
		targetKey: text(event.targetKey, "target key", MAX_ID_BYTES),
		type: "filesystem.created",
		createdAt: nonNegativeNumber(event.createdAt, "event creation time"),
		summary: stringValue(event.summary, "event summary", MAX_SUMMARY_BYTES),
		payload: {
			relativePath: text(payload.relativePath, "payload relative path", MAX_PATH_BYTES),
			path: text(payload.path, "payload path", MAX_PATH_BYTES),
			fileType: "regular",
			size: integer(payload.size, "payload size"),
			mtimeMs: nonNegativeNumber(payload.mtimeMs, "payload modification time"),
		},
		delivery: validateDelivery(event.delivery),
	};
	if (result.eventId !== key) throw new Error("event id does not match map key");
	return result;
}

function validateDelivery(value: unknown): HostedEventDelivery {
	const candidate = strictObject(value, "event delivery");
	if (candidate.status === "pending") {
		const delivery = strictObject(value, "pending delivery", ["status", "latestClaimId"]);
		return delivery.latestClaimId === undefined
			? { status: "pending" }
			: { status: "pending", latestClaimId: text(delivery.latestClaimId, "latest claim id", MAX_ID_BYTES) };
	}
	if (candidate.status === "claimed") {
		const delivery = strictObject(value, "claimed delivery", ["status", "claimId"]);
		return { status: "claimed", claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES) };
	}
	if (candidate.status === "acked") {
		const delivery = strictObject(value, "acknowledged delivery", ["status", "claimId", "ackedAt"]);
		return {
			status: "acked",
			claimId: text(delivery.claimId, "claim id", MAX_ID_BYTES),
			ackedAt: nonNegativeNumber(delivery.ackedAt, "acknowledgement time"),
		};
	}
	throw new Error("invalid delivery status");
}

function validateClaim(value: unknown, key: string): HostedClaim {
	const claim = strictObject(value, "claim", ["claimId", "targetKey", "registrationId", "clientGeneration", "eventIds", "createdAt", "leaseUntil", "status", "settledAt"]);
	if (claim.status !== "active" && claim.status !== "released" && claim.status !== "acked") throw new Error("invalid claim status");
	const eventIds = stringArray(claim.eventIds, "claim event ids", HOSTED_MAX_DELIVERY_BATCH);
	if (eventIds.length < 1 || new Set(eventIds).size !== eventIds.length) throw new Error("invalid claim event ids");
	const result: HostedClaim = {
		claimId: text(claim.claimId, "claim id", MAX_ID_BYTES),
		targetKey: text(claim.targetKey, "target key", MAX_ID_BYTES),
		registrationId: text(claim.registrationId, "registration id", MAX_ID_BYTES),
		clientGeneration: text(claim.clientGeneration, "client generation", MAX_ID_BYTES),
		eventIds,
		createdAt: nonNegativeNumber(claim.createdAt, "claim creation time"),
		leaseUntil: nonNegativeNumber(claim.leaseUntil, "claim lease"),
		status: claim.status,
		...(claim.settledAt === undefined ? {} : { settledAt: nonNegativeNumber(claim.settledAt, "claim settled time") }),
	};
	if (result.claimId !== key || result.leaseUntil <= result.createdAt) throw new Error("invalid claim identity or lease");
	if (result.status === "active" ? result.settledAt !== undefined : result.settledAt === undefined) throw new Error("invalid claim settlement");
	return result;
}

function validateWake(value: unknown, key: string): HostedWake {
	const wake = strictObject(value, "wake", ["wakeId", "targetKey", "registrationId", "createdAt"]);
	const result: HostedWake = {
		wakeId: text(wake.wakeId, "wake id", MAX_ID_BYTES),
		targetKey: text(wake.targetKey, "target key", MAX_ID_BYTES),
		registrationId: text(wake.registrationId, "registration id", MAX_ID_BYTES),
		createdAt: nonNegativeNumber(wake.createdAt, "wake creation time"),
	};
	if (result.targetKey !== key) throw new Error("wake target does not match map key");
	return result;
}

function validateReferences(state: HostedRuntimeState): void {
	for (const monitor of Object.values(state.monitors)) if (!state.targets[monitor.targetKey]) throw new Error("monitor target is missing");
	for (const [dedupeKey, eventId] of Object.entries(state.dedupe)) {
		const event = state.events[eventId];
		if (!event || event.dedupeKey !== dedupeKey) throw new Error("event dedupe reference is invalid");
	}
	for (const event of Object.values(state.events)) {
		if (!state.targets[event.targetKey] || state.dedupe[event.dedupeKey] !== event.eventId) throw new Error("event references are invalid");
		const claimId = event.delivery.status === "pending" ? event.delivery.latestClaimId : event.delivery.claimId;
		const claim = claimId ? state.claims[claimId] : undefined;
		if (claimId && (!claim || claim.targetKey !== event.targetKey || !claim.eventIds.includes(event.eventId))) throw new Error("event claim reference is invalid");
	}
	for (const claim of Object.values(state.claims)) {
		if (!state.targets[claim.targetKey]) throw new Error("claim target is missing");
		for (const eventId of claim.eventIds) if (state.events[eventId]?.targetKey !== claim.targetKey) throw new Error("claim event reference is invalid");
	}
	for (const wake of Object.values(state.wakes)) if (!state.targets[wake.targetKey]) throw new Error("wake target is missing");
}

function mapValues<T>(value: unknown, name: string, validate: (item: unknown, key: string) => T, max = MAX_STATE_RECORDS): Record<string, T> {
	const record = strictObject(value, name);
	const entries = Object.entries(record);
	if (entries.length > max) throw new Error(`${name} exceeds ${max} entries`);
	return Object.fromEntries(entries.map(([key, item]) => [key, validate(item, key)]));
}

function mapStrings(value: unknown, name: string): Record<string, string> {
	const record = strictObject(value, name);
	if (Object.keys(record).length > MAX_STATE_RECORDS) throw new Error(`${name} exceeds ${MAX_STATE_RECORDS} entries`);
	return Object.fromEntries(Object.entries(record).map(([key, item]) => [text(key, `${name} key`, MAX_PATH_BYTES), text(item, `${name} value`, MAX_ID_BYTES)]));
}

function strictObject(value: unknown, name: string, allowed?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	const record = value as Record<string, unknown>;
	if (allowed) for (const key of Object.keys(record)) if (!allowed.includes(key)) throw new Error(`${name} has unknown field ${key}`);
	return record;
}

function stringArray(value: unknown, name: string, max: number): string[] {
	if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must contain at most ${max} values`);
	return value.map((item) => text(item, name, MAX_ID_BYTES));
}

function text(value: unknown, name: string, maxBytes: number): string {
	const result = stringValue(value, name, maxBytes);
	if (!result.trim()) throw new Error(`${name} must not be empty`);
	return result;
}

function stringValue(value: unknown, name: string, maxBytes: number): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) throw new Error(`${name} must be a string of at most ${maxBytes} bytes`);
	return value;
}

function integer(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
	return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
	return value;
}

function boolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function sameTarget(left: HostedTarget, right: HostedTarget): boolean {
	return left.targetKey === right.targetKey && left.projectRoot === right.projectRoot && left.piSessionId === right.piSessionId && left.piSessionFile === right.piSessionFile;
}

function sameMonitorIdentity(left: HostedMonitor, right: HostedMonitor): boolean {
	return left.monitorId === right.monitorId
		&& left.targetKey === right.targetKey
		&& left.generation === right.generation
		&& left.directory === right.directory
		&& left.settleMs === right.settleMs;
}

function sameClaim(left: HostedClaim, right: HostedClaim): boolean {
	return left.claimId === right.claimId && left.targetKey === right.targetKey && left.registrationId === right.registrationId && left.clientGeneration === right.clientGeneration && sameIds(left.eventIds, right.eventIds);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	const leftSorted = [...left].sort();
	const rightSorted = [...right].sort();
	return leftSorted.every((value, index) => value === rightSorted[index]);
}

function storageError(message: string, cause: unknown): HostedStateStorageError {
	if (cause instanceof HostedStateStorageError) return cause;
	return new HostedStateStorageError(`${message}: ${cause instanceof Error ? cause.message : String(cause)}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
