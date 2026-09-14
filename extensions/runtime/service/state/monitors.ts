import {
	HOSTED_MONITOR_MAX_ENTRIES,
	type HostedFilesystemCreatedEvent,
	type HostedMonitor,
	type HostedRuntimeState,
	type HostedStateOperation,
} from "../../hosted-types.ts";
import { sameMonitorIdentity } from "./compare.ts";
import { HostedStateConflictError } from "./errors.ts";

type CreateOperation = Extract<HostedStateOperation, { type: "monitor.create" }>;
type DeleteOperation = Extract<HostedStateOperation, { type: "monitor.delete" }>;
type CommitOperation = Extract<HostedStateOperation, { type: "monitor.commit" }>;

export function createMonitor(state: HostedRuntimeState, operation: CreateOperation): HostedRuntimeState {
	const monitor = operation.monitor;
	if (!state.targets[monitor.targetKey] || Object.keys(monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
	const existingId = state.monitors[monitor.monitorId];
	if (existingId && !sameMonitorIdentity(existingId, monitor)) {
		throw new HostedStateConflictError("conflict", "Monitor ID already belongs to another monitor.");
	}
	const existingTarget = Object.values(state.monitors).find((candidate) => candidate.targetKey === monitor.targetKey);
	if (existingTarget) {
		if (existingTarget.directory !== monitor.directory) {
			throw new HostedStateConflictError("conflict", "Target already owns another monitor.");
		}
		return state;
	}
	return { ...state, monitors: { ...state.monitors, [monitor.monitorId]: monitor } };
}

export function deleteMonitor(state: HostedRuntimeState, operation: DeleteOperation): HostedRuntimeState {
	const monitor = state.monitors[operation.monitorId];
	if (!monitor || monitor.targetKey !== operation.targetKey) return state;
	const monitors = { ...state.monitors };
	delete monitors[operation.monitorId];
	return { ...state, monitors };
}

export function commitMonitor(state: HostedRuntimeState, operation: CommitOperation): HostedRuntimeState {
	const current = state.monitors[operation.monitor.monitorId];
	if (!current || !sameMonitorIdentity(current, operation.monitor)) return state;
	if (!commitAdvances(current, operation.monitor)) return state;
	if (Object.keys(operation.monitor.entries).length > HOSTED_MONITOR_MAX_ENTRIES) return state;
	if (operation.events.some((event) => !validMonitorEvent(operation.monitor, event))) return state;
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

function commitAdvances(current: HostedMonitor, next: HostedMonitor): boolean {
	return next.createdAt === current.createdAt && next.updatedAt >= current.updatedAt;
}

function validMonitorEvent(monitor: HostedMonitor, event: HostedFilesystemCreatedEvent): boolean {
	return event.version === 1
		&& event.targetKey === monitor.targetKey
		&& event.source.kind === "monitor"
		&& event.source.id === monitor.monitorId
		&& event.deliveredAt === undefined;
}
