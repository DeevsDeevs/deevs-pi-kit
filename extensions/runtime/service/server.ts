import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { DirectoryMonitorManager, type DirectoryMonitorOptions } from "./monitor.ts";
import { dispatchHostedLine, encodeHostedResponse, HOSTED_MAX_REQUEST_BYTES, invalidFrame, type HostedProtocolContext } from "./protocol.ts";
import { HostedParticipantCoordinator, type HostedParticipantCoordinatorOptions } from "./participant.ts";
import { HerdrCliHostVerifier, RuntimeRegistrationManager, type HostedHostVerifier, type RegistrationManagerOptions } from "./registration.ts";
import { HostedStateStore, loadOrCreateRuntimeInstance } from "./state.ts";
import { HostedWakeCoordinator, type HostedWakeOptions } from "./wake.ts";

export class RuntimeAlreadyRunningError extends Error {
	readonly code = "conflict" as const;
}

export interface RuntimeServerOptions {
	root: string;
	socketPath?: string;
	epoch?: string;
	probeTimeoutMs?: number;
	monitor?: DirectoryMonitorOptions;
	host?: HostedHostVerifier;
	registration?: RegistrationManagerOptions;
	participant?: HostedParticipantCoordinatorOptions;
	wake?: HostedWakeOptions;
}

export interface RuntimeServerHandle {
	root: string;
	socketPath: string;
	runtimeId: string;
	epoch: string;
	close(): Promise<void>;
}

export async function startRuntimeServer(options: RuntimeServerOptions): Promise<RuntimeServerHandle> {
	const instance = loadOrCreateRuntimeInstance(options.root);
	const store = new HostedStateStore(options.root);
	const host = options.host ?? new HerdrCliHostVerifier();
	let wakes: HostedWakeCoordinator | undefined;
	let participants: HostedParticipantCoordinator | undefined;
	const monitors = new DirectoryMonitorManager(store, {
		...options.monitor,
		onEvents: (targetKey) => {
			options.monitor?.onEvents?.(targetKey);
			wakes?.request(targetKey);
		},
	});
	const registrations = new RuntimeRegistrationManager(store, host, {
		...options.registration,
		onReady: (targetKey) => {
			options.registration?.onReady?.(targetKey);
			participants?.registrationReady(targetKey);
			wakes?.request(targetKey);
		},
	});
	wakes = new HostedWakeCoordinator(store, registrations, host, options.wake);
	participants = new HostedParticipantCoordinator(store, registrations, wakes, {
		...options.participant,
		stopTarget: options.participant?.stopTarget ?? (host.closeTarget ? (target) => host.closeTarget!(target, join(options.root, "collaborator-sessions")) : undefined),
	});
	const socketPath = options.socketPath ?? join(options.root, "runtime.sock");
	const context: HostedProtocolContext = {
		runtimeId: instance.runtimeId,
		epoch: options.epoch ?? `epoch_${randomUUID()}`,
		agentWake: "herdr_exact_agent",
		registrations,
		monitors,
		wakes,
		participants,
	};
	const sockets = new Set<Socket>();
	const server = createServer((socket) => handleConnection(socket, context, sockets));
	await listenWithStaleRecovery(server, socketPath, options.probeTimeoutMs ?? 250);
	try {
		chmodSync(socketPath, 0o600);
		const identity = socketIdentity(socketPath);
		monitors.start();
		let closed = false;
		return {
			root: options.root,
			socketPath,
			runtimeId: instance.runtimeId,
			epoch: context.epoch,
			async close() {
				if (closed) return;
				closed = true;
				monitors.close();
				wakes.close();
				registrations.close();
				for (const socket of sockets) socket.destroy();
				await closeServer(server);
				if (sameSocket(socketPath, identity)) try { unlinkSync(socketPath); } catch {}
			},
		};
	} catch (error) {
		monitors.close();
		wakes.close();
		registrations.close();
		await closeServer(server);
		try { unlinkSync(socketPath); } catch {}
		throw error;
	}
}

async function listenWithStaleRecovery(server: Server, socketPath: string, probeTimeoutMs: number): Promise<void> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			await listenOnce(server, socketPath);
			return;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EADDRINUSE") throw error;
			if (await probeSocket(socketPath, probeTimeoutMs)) throw new RuntimeAlreadyRunningError(`Runtime is already listening at ${socketPath}.`);
			// ponytail: a fully saturated local socket backlog could look stale; add an OS lock only if this same-uid self-DoS appears in practice.
			const stale = `${socketPath}.stale.${process.pid}.${randomUUID()}`;
			try {
				renameSync(socketPath, stale);
				try { unlinkSync(stale); } catch {}
			} catch (renameError) {
				if (!isNodeError(renameError) || renameError.code !== "ENOENT") throw renameError;
			}
		}
	}
	throw new RuntimeAlreadyRunningError(`Runtime socket remained busy at ${socketPath}.`);
}

function handleConnection(socket: Socket, context: HostedProtocolContext, sockets: Set<Socket>): void {
	sockets.add(socket);
	socket.once("close", () => sockets.delete(socket));
	socket.on("error", () => {});
	let buffered = Buffer.alloc(0);
	let closing = false;
	let processing = false;
	socket.on("data", (chunk: Buffer) => {
		if (closing) return;
		buffered = Buffer.concat([buffered, chunk]);
		void drain();
	});

	async function drain(): Promise<void> {
		if (processing || closing) return;
		processing = true;
		socket.pause();
		try {
			while (!closing) {
				const newline = buffered.indexOf(0x0a);
				if (newline < 0) {
					if (buffered.length > HOSTED_MAX_REQUEST_BYTES) {
						closing = true;
						writeAndClose(socket, encodeHostedResponse(invalidFrame(`Request exceeds ${HOSTED_MAX_REQUEST_BYTES} bytes.`)));
					}
					break;
				}
				if (newline > HOSTED_MAX_REQUEST_BYTES) {
					closing = true;
					writeAndClose(socket, encodeHostedResponse(invalidFrame(`Request exceeds ${HOSTED_MAX_REQUEST_BYTES} bytes.`)));
					break;
				}
				const frame = buffered.subarray(0, newline);
				buffered = buffered.subarray(newline + 1);
				const line = frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame;
				let decoded: string;
				try {
					decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
				} catch {
					closing = true;
					writeAndClose(socket, encodeHostedResponse(invalidFrame("Request is not valid UTF-8.")));
					break;
				}
				const response = await dispatchHostedLine(decoded, context);
				if (!response.ok && response.id === null) {
					closing = true;
					writeAndClose(socket, encodeHostedResponse(response));
					break;
				}
				socket.write(encodeHostedResponse(response));
			}
		} finally {
			processing = false;
			if (!closing) socket.resume();
		}
	}
}

function writeAndClose(socket: Socket, value: string): void {
	socket.end(value);
}

function listenOnce(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath);
	});
}

function probeSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (connected: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(connected);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		timer.unref?.();
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve) => server.close(() => resolve()));
}

function socketIdentity(path: string): { dev: number; ino: number } {
	const info = lstatSync(path);
	if (!info.isSocket()) throw new Error(`Runtime socket path is not a socket: ${path}`);
	return { dev: info.dev, ino: info.ino };
}

function sameSocket(path: string, identity: { dev: number; ino: number }): boolean {
	try {
		const info = lstatSync(path);
		return info.isSocket() && info.dev === identity.dev && info.ino === identity.ino;
	} catch {
		return false;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
