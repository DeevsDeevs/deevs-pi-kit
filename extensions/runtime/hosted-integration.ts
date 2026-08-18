import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HostedRuntimeClient, HostedRuntimeClientError } from "./client.ts";

const HEARTBEAT_MS = 10_000;

interface LiveClientRegistration {
	targetKey: string;
	registrationId: string;
	registrationKey: string;
	leaseUntil: number;
	hostStateChangeSeq: number;
	paneId: string;
}

export class HostedRuntimeIntegration {
	private readonly pi: ExtensionAPI;
	private readonly root: string;
	private readonly client: HostedRuntimeClient;
	private readonly clientGeneration = `client_${randomUUID()}`;
	private registration?: LiveClientRegistration;
	private heartbeatTimer?: NodeJS.Timeout;
	private active = false;

	constructor(pi: ExtensionAPI, root = defaultRuntimeRoot()) {
		this.pi = pi;
		this.root = root;
		this.client = new HostedRuntimeClient(join(root, "runtime.sock"));
	}

	async sessionStart(ctx: ExtensionContext): Promise<void> {
		this.active = true;
		if (!existsSync(this.client.socketPath)) return;
		try { await this.register(ctx); } catch {}
	}

	async sessionShutdown(): Promise<void> {
		this.active = false;
		this.stopHeartbeat();
		const registration = this.registration;
		this.registration = undefined;
		if (!registration) return;
		try {
			await this.client.call("pi.unregister", { registrationId: registration.registrationId, registrationKey: registration.registrationKey });
		} catch {}
	}

	async command(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
		try {
			if (action === "start") {
				await this.start(ctx);
				await this.register(ctx);
				ctx.ui.notify("Runtime service started and this Pi session is registered.", "info");
				return;
			}
			if (action === "register") {
				await this.register(ctx);
				ctx.ui.notify("This Pi session is registered with Runtime.", "info");
				return;
			}
			if (action === "monitor") {
				if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Monitor creation requires a trusted project.");
				const directory = rest.join(" ");
				if (!directory) throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime monitor <directory>");
				const registration = await this.requireRegistration(ctx);
				const result = await this.client.call("monitor.create", { ...auth(registration), directory: resolve(ctx.cwd, directory), settleMs: 250 });
				ctx.ui.notify(`Runtime Monitor active: ${monitorSummary(result)}`, "info");
				return;
			}
			if (action === "monitor-delete") {
				const registration = await this.requireRegistration(ctx);
				const status = await this.client.call("monitor.get", auth(registration));
				const monitorId = monitorIdFromStatus(status);
				if (!monitorId) {
					ctx.ui.notify("No Runtime Monitor is configured for this session.", "info");
					return;
				}
				await this.client.call("monitor.delete", { ...auth(registration), monitorId });
				ctx.ui.notify("Runtime Monitor deleted; queued events were retained.", "info");
				return;
			}
			if (action !== "status") throw new HostedRuntimeClientError("invalid_request", "Usage: /runtime [status|start|register|monitor <directory>|monitor-delete]");
			const hello = strictObject(await this.client.hello(), "Runtime hello");
			const registration = this.registration;
			ctx.ui.notify(`Runtime ${String(hello.runtimeId)} (${String(hello.epoch)}); Pi ${registration ? `registered until ${new Date(registration.leaseUntil).toISOString()}` : "not registered"}.`, "info");
		} catch (error) {
			ctx.ui.notify(`${errorCode(error)}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	private async start(ctx: ExtensionCommandContext): Promise<void> {
		try {
			await this.client.hello();
			return;
		} catch {}
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) throw new HostedRuntimeClientError("host_unavailable", "Explicit Runtime start requires this Pi session to run inside Herdr.");
		if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Runtime start requires a trusted project.");
		const created = await this.pi.exec("herdr", ["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID, "--cwd", ctx.cwd, "--label", "pi-kit-runtime", "--no-focus"], { timeout: 5_000 });
		if (created.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not create the Runtime service tab.");
		const result = strictObject(strictObject(JSON.parse(created.stdout), "Herdr response").result, "Herdr result");
		const paneId = text(strictObject(result.root_pane, "Herdr root pane").pane_id);
		const tabId = text(strictObject(result.tab, "Herdr tab").tab_id);
		const serviceMain = fileURLToPath(new URL("./service/main.ts", import.meta.url));
		const command = `exec node ${shellQuote(serviceMain)} --root ${shellQuote(this.root)}`;
		const launched = await this.pi.exec("herdr", ["pane", "run", paneId, command], { timeout: 5_000 });
		if (launched.code !== 0) {
			await this.pi.exec("herdr", ["tab", "close", tabId], { timeout: 5_000 });
			throw new HostedRuntimeClientError("host_unavailable", "Herdr could not launch the Runtime service.");
		}
		for (let attempt = 0; attempt < 30; attempt++) {
			try { await this.client.hello(); return; } catch { await delay(100); }
		}
		await this.pi.exec("herdr", ["tab", "close", tabId], { timeout: 5_000 });
		throw new HostedRuntimeClientError("unavailable", "Runtime service did not become ready.");
	}

	private async requireRegistration(ctx: ExtensionContext): Promise<LiveClientRegistration> {
		if (this.registration) return this.registration;
		return this.register(ctx);
	}

	private async register(ctx: ExtensionContext): Promise<LiveClientRegistration> {
		if (!ctx.isProjectTrusted()) throw new HostedRuntimeClientError("untrusted", "Runtime registration requires a trusted project.");
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) throw new HostedRuntimeClientError("invalid_request", "Runtime requires a persisted Pi session.");
		const sessionId = ctx.sessionManager.getSessionId();
		const host = await this.currentHerdrPane();
		const result = await this.client.call("pi.register", {
			projectRoot: realpathSync(ctx.cwd),
			piSessionId: sessionId,
			piSessionFile: realpathSync(sessionFile),
			clientGeneration: this.clientGeneration,
			admittedClaims: [],
			herdr: { paneId: host.paneId, terminalId: host.terminalId },
		});
		const registration = parseRegistration(result);
		if (!this.active) {
			try { await this.client.call("pi.unregister", auth(registration)); } catch {}
			throw new HostedRuntimeClientError("registration_stale", "Pi session shut down while registration was in flight.");
		}
		this.registration = registration;
		this.startHeartbeat();
		return registration;
	}

	private async currentHerdrPane(): Promise<{ paneId: string; terminalId: string }> {
		const current = await this.pi.exec("herdr", ["pane", "current", "--current"], { timeout: 2_000 });
		if (current.code !== 0) throw new HostedRuntimeClientError("host_unavailable", "Herdr could not resolve this Pi pane.");
		const pane = strictObject(strictObject(JSON.parse(current.stdout), "Herdr response").result, "Herdr result").pane;
		const value = strictObject(pane, "Herdr pane");
		return { paneId: text(value.pane_id), terminalId: text(value.terminal_id) };
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}

	private async heartbeat(): Promise<void> {
		const registration = this.registration;
		if (!registration) return;
		try {
			this.registration = parseRegistration(await this.client.call("pi.heartbeat", auth(registration)));
		} catch {
			this.registration = undefined;
			this.stopHeartbeat();
		}
	}
}

function defaultRuntimeRoot(): string {
	return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "runtime");
}

function parseRegistration(value: unknown): LiveClientRegistration {
	const result = strictObject(value, "Runtime registration");
	return {
		targetKey: text(result.targetKey),
		registrationId: text(result.registrationId),
		registrationKey: text(result.registrationKey),
		leaseUntil: integer(result.leaseUntil),
		hostStateChangeSeq: integer(result.hostStateChangeSeq),
		paneId: text(result.paneId),
	};
}

function auth(registration: LiveClientRegistration): { registrationId: string; registrationKey: string } {
	return { registrationId: registration.registrationId, registrationKey: registration.registrationKey };
}

function monitorSummary(value: unknown): string {
	const monitor = strictObject(value, "Runtime Monitor");
	return `${text(monitor.monitorId)} (${text(monitor.status)})`;
}

function monitorIdFromStatus(value: unknown): string | undefined {
	const status = strictObject(value, "Runtime Monitor status");
	if (status.monitor === null) return undefined;
	return text(strictObject(status.monitor, "Runtime Monitor").monitorId);
}

function errorCode(error: unknown): string {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "internal";
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostedRuntimeClientError("invalid_response", `${name} must be an object.`);
	return value as Record<string, unknown>;
}

function text(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new HostedRuntimeClientError("invalid_response", "Expected non-empty text.");
	return value;
}

function integer(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HostedRuntimeClientError("invalid_response", "Expected a non-negative integer.");
	return value;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
