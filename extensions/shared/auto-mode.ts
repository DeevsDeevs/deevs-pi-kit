import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AUTO_MODE_CUSTOM_TYPE = "deevs.auto-mode.v1";

const globalRegistry = globalThis as typeof globalThis & { __deevsPiKitAutoMode?: WeakMap<object, boolean> };
const sessions = globalRegistry.__deevsPiKitAutoMode ??= new WeakMap<object, boolean>();

export function isAutoModeEnabled(ctx: ExtensionContext): boolean {
	return sessions.get(ctx.sessionManager) === true;
}

export function setAutoMode(ctx: ExtensionContext, enabled: boolean): void {
	sessions.set(ctx.sessionManager, enabled);
}

export function loadAutoModeFromSession(ctx: ExtensionContext): boolean {
	let enabled = false;
	for (const entry of ctx.sessionManager.getBranch() as Array<any>) {
		if (entry.type === "custom" && entry.customType === AUTO_MODE_CUSTOM_TYPE) {
			enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled === true;
		}
	}
	setAutoMode(ctx, enabled);
	return enabled;
}
