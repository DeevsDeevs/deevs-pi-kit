import { Key, matchesKey, SelectList, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, SelectItem, SelectListTheme, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
import type { ProcessManager } from "./manager.ts";
import type { ManagedProcessInfo, ProcessStatus, ReadStreamFilter } from "./types.ts";

const DOCK_ID = "background-tasks";
const LOG_VIEW_BYTES = 200_000;
const LOG_VIEW_ROWS = 28;

interface DockState {
	visible: boolean;
	component?: ProcessDock;
	requestRender?: () => void;
	unsubscribe?: () => void;
}

export function createProcessUi(manager: ProcessManager, onSettingsChanged?: (ctx: any) => void | Promise<void>) {
	const dock: DockState = { visible: false };

	return {
		showDock(ctx: any) {
			manager.getConfig().ui.dockEnabled = true;
			void onSettingsChanged?.(ctx);
			if (dock.visible) {
				dock.component?.invalidate();
				dock.requestRender?.();
				return;
			}
			dock.visible = true;
			ctx.ui.setWidget(
				DOCK_ID,
				(tui: any, theme: any) => {
					dock.requestRender = () => tui.requestRender();
					dock.component = new ProcessDock(manager, theme);
					return dock.component;
				},
				{ placement: "belowEditor" },
			);
			dock.unsubscribe = manager.onChange(() => {
				dock.component?.invalidate();
				dock.requestRender?.();
			});
		},

		hideDock(ctx: any) {
			manager.getConfig().ui.dockEnabled = false;
			void onSettingsChanged?.(ctx);
			dock.unsubscribe?.();
			dock.unsubscribe = undefined;
			dock.requestRender = undefined;
			dock.component = undefined;
			dock.visible = false;
			ctx.ui.setWidget(DOCK_ID, undefined);
		},

		toggleDock(ctx: any) {
			if (dock.visible) this.hideDock(ctx);
			else this.showDock(ctx);
			return dock.visible;
		},

		isDockVisible() {
			return dock.visible;
		},

		async showPanel(ctx: any) {
			await ctx.ui.custom(
				(tui: any, theme: any, _keybindings: any, done: () => void) =>
					new ProcessPanel(manager, ctx, theme, done, () => tui.requestRender()),
				{ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center", margin: 1 } },
			);
		},

		async showLogViewer(ctx: any, processId: string, stream: ReadStreamFilter = "combined") {
			const process = manager.list({ includeExited: true, includePersistent: true }).find((item) => item.id === processId);
			const logs = await manager.logs({ id: processId, stream, maxBytes: LOG_VIEW_BYTES });
			if (!logs) {
				ctx.ui.notify("No logs for this process.", "info");
				return;
			}
			await ctx.ui.custom(
				(tui: any, theme: any, _keybindings: any, done: () => void) =>
					new LogViewer(process?.name ?? processId, logs.stream, logs.content, logs.truncatedFromStart, theme, done, () => tui.requestRender()),
				{ overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center", margin: 1 } },
			);
		},

		async showSettings(ctx: any) {
			await ctx.ui.custom(
				(tui: any, theme: any, _keybindings: any, done: () => void) =>
					new ProcessSettings(manager, theme, done, () => tui.requestRender(), () => {
						if (dock.visible) {
							dock.component?.invalidate();
							dock.requestRender?.();
						}
						void onSettingsChanged?.(ctx);
					}),
				{ overlay: true, overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center", margin: 1 } },
			);
		},
	};
}

export function renderDockLines(manager: ProcessManager, theme?: any, width = Number.POSITIVE_INFINITY): string[] {
	const processes = manager.list({ includeExited: false, includePersistent: true });
	const config = manager.getConfig();
	const accent = (text: string) => theme?.fg ? theme.fg("accent", text) : text;
	const muted = (text: string) => theme?.fg ? theme.fg("muted", text) : text;
	const lines: string[] = [];

	if (!config.ui.dockEnabled) return [truncateToWidth(`${accent("background-tasks")}: ${muted("dock disabled")}`, width)];
	if (processes.length === 0) return [truncateToWidth(`${accent("background-tasks")}: ${muted("idle")}`, width)];

	lines.push(truncateToWidth(`${accent("background-tasks")}: ${processes.length} running`, width));
	for (const process of processes.slice(0, Math.max(1, config.ui.dockHeight - 1))) {
		const runtime = formatDuration(Date.now() - process.startedAt);
		lines.push(truncateToWidth(`${statusIcon(process.status)} ${process.name} ${runtime} - ${shortCommand(process)}`, width));
	}
	if (processes.length > config.ui.dockHeight - 1) lines.push(truncateToWidth(`... ${processes.length - (config.ui.dockHeight - 1)} more`, width));
	return lines;
}

class ProcessDock implements Component {
	constructor(
		private readonly manager: ProcessManager,
		private readonly theme: any,
	) {}

	render(width: number): string[] {
		return renderDockLines(this.manager, this.theme, width);
	}

	invalidate(): void {}
}

class ProcessPanel implements Component {
	private selectedId?: string;
	private list?: SelectList;
	private listKey = "";
	private unsubscribe: () => void;

	constructor(
		private readonly manager: ProcessManager,
		private readonly ctx: any,
		private readonly theme: any,
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {
		this.unsubscribe = manager.onChange(() => {
			this.invalidate();
			this.requestRender();
		});
	}

	handleInput(data: string): void {
		const process = this.selectedProcess();
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
			this.close();
			return;
		}
		if (matchesKey(data, "r")) this.showRead(process);
		else if (matchesKey(data, "l")) void this.showLogs(process);
		else if (matchesKey(data, "k")) void this.kill(process, "SIGTERM");
		else if (matchesKey(data, "i")) void this.kill(process, "SIGINT");
		else if (matchesKey(data, "x")) void this.kill(process, "SIGKILL");
		else if (matchesKey(data, "a")) void this.killAll();
		else if (matchesKey(data, "c")) void this.clear(process);
		else this.ensureList().handleInput(data);

		this.selectedId = this.ensureList().getSelectedItem()?.value;
		this.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const list = this.ensureList();
		const selected = this.selectedProcess();
		const lines: string[] = [];

		lines.push(truncateToWidth(th.fg("accent", th.bold(" background-tasks ")), width));
		lines.push(truncateToWidth(th.fg("borderMuted", "-".repeat(width)), width));
		lines.push(truncateToWidth(th.fg("dim", "up/down select | enter/r read | l log viewer | k term | i int | x kill | a kill all | c clear | q close"), width));
		lines.push("");
		lines.push(...list.render(width));
		lines.push("");
		if (selected) {
			lines.push(truncateToWidth(th.fg("borderMuted", "-".repeat(width)), width));
			lines.push(truncateToWidth(`id: ${selected.id} | status: ${selected.status} | cwd: ${selected.cwd}`, width));
			lines.push(truncateToWidth(`cmd: ${shortCommand(selected, 240)}`, width));
		} else {
			lines.push(truncateToWidth(th.fg("dim", "No managed processes."), width));
		}
		return lines;
	}

	invalidate(): void {
		this.list = undefined;
		this.listKey = "";
	}

	private ensureList(): SelectList {
		const processes = this.processes();
		const key = processes.map((process) => `${process.id}:${process.status}:${process.endedAt ?? 0}:${process.stats.lastOutputAt ?? 0}`).join("|");
		if (this.list && this.listKey === key) return this.list;

		const items = processes.map((process): SelectItem => ({
			value: process.id,
			label: formatListLabel(process),
			description: shortCommand(process, 160),
		}));
		this.list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), selectListTheme(this.theme), {
			minPrimaryColumnWidth: 28,
			maxPrimaryColumnWidth: 56,
		});
		this.list.onSelect = (item) => {
			this.selectedId = item.value;
			this.showRead(this.selectedProcess());
		};
		this.list.onCancel = () => this.close();
		this.list.onSelectionChange = (item) => {
			this.selectedId = item.value;
		};

		const selectedIndex = Math.max(0, items.findIndex((item) => item.value === this.selectedId));
		if (items.length > 0) {
			this.list.setSelectedIndex(selectedIndex);
			this.selectedId = items[selectedIndex]?.value;
		} else {
			this.selectedId = undefined;
		}
		this.listKey = key;
		return this.list;
	}

	private processes(): ManagedProcessInfo[] {
		return this.manager.list({ includeExited: true, includePersistent: true });
	}

	private selectedProcess(): ManagedProcessInfo | undefined {
		const processes = this.processes();
		return processes.find((process) => process.id === this.selectedId) ?? processes[0];
	}

	private showRead(process: ManagedProcessInfo | undefined): void {
		if (!process) return;
		this.ctx.ui.notify(this.manager.formatRead(process.id, 16_384), "info");
	}

	private async showLogs(process: ManagedProcessInfo | undefined): Promise<void> {
		if (!process) return;
		const logs = await this.manager.logs({ id: process.id, maxBytes: LOG_VIEW_BYTES });
		if (!logs) {
			this.ctx.ui.notify("No logs for this process.", "info");
			return;
		}
		await this.ctx.ui.custom(
			(tui: any, theme: any, _keybindings: any, done: () => void) =>
				new LogViewer(process.name, logs.stream, logs.content, logs.truncatedFromStart, theme, done, () => tui.requestRender()),
			{ overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center", margin: 1 } },
		);
		this.requestRender();
	}

	private async kill(process: ManagedProcessInfo | undefined, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> {
		if (!process) return;
		const next = await this.manager.signal({ id: process.id, signal, tree: true, timeoutMs: 5000 });
		this.ctx.ui.notify(`${next.id} is ${next.status}`, "info");
	}

	private async killAll(): Promise<void> {
		const targets = this.manager.list({ includeExited: false, includePersistent: true });
		if (targets.length === 0) {
			this.ctx.ui.notify("No running managed processes.", "info");
			return;
		}
		const results = await Promise.allSettled(
			targets.map((process) => this.manager.signal({ id: process.id, signal: "SIGTERM", tree: true, timeoutMs: 5000 })),
		);
		const failed = targets.filter((_process, index) => results[index]?.status === "rejected");
		this.ctx.ui.notify(`Signaled ${targets.length - failed.length} process(es).${failed.length ? ` Failed: ${failed.map((process) => process.id).join(", ")}` : ""}`, "info");
	}

	private async clear(process: ManagedProcessInfo | undefined): Promise<void> {
		if (!process) return;
		try {
			const result = await this.manager.clear({ id: process.id });
			this.ctx.ui.notify(`Cleared ${result.cleared.length} process record(s).`, "info");
		} catch (error) {
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	private close(): void {
		this.unsubscribe();
		this.done();
	}
}

class LogViewer implements Component {
	private readonly lines: string[];
	private scroll = 0;
	private query = "";
	private searchMode = false;

	constructor(
		private readonly processName: string,
		private readonly stream: string,
		content: string,
		private readonly truncatedFromStart: boolean,
		private readonly theme: any,
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {
		this.lines = content.length > 0 ? content.replace(/\n$/, "").split("\n") : ["(no log output)"];
		this.scroll = Math.max(0, this.filteredLines().length - LOG_VIEW_ROWS);
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			if (matchesKey(data, Key.escape)) this.searchMode = false;
			else if (matchesKey(data, Key.enter)) this.searchMode = false;
			else if (matchesKey(data, Key.backspace)) this.query = this.query.slice(0, -1);
			else if (isPrintable(data)) this.query += data;
			this.clampScroll();
			this.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) this.done();
		else if (matchesKey(data, "/") || matchesKey(data, "f")) this.searchMode = true;
		else if (matchesKey(data, Key.up)) this.scroll -= 1;
		else if (matchesKey(data, Key.down)) this.scroll += 1;
		else if (matchesKey(data, Key.pageUp)) this.scroll -= LOG_VIEW_ROWS;
		else if (matchesKey(data, Key.pageDown)) this.scroll += LOG_VIEW_ROWS;
		else if (matchesKey(data, "g")) this.scroll = 0;
		else if (matchesKey(data, Key.shift("g"))) this.scroll = Math.max(0, this.filteredLines().length - LOG_VIEW_ROWS);
		else if (matchesKey(data, "c")) this.query = "";
		this.clampScroll();
		this.requestRender();
	}

	render(width: number): string[] {
		const lines = this.filteredLines();
		this.clampScroll();
		const visible = lines.slice(this.scroll, this.scroll + LOG_VIEW_ROWS);
		const out: string[] = [];
		const title = ` logs: ${this.processName} (${this.stream}) `;
		out.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(title)), width));
		out.push(truncateToWidth(this.theme.fg("borderMuted", "-".repeat(width)), width));
		out.push(truncateToWidth(this.theme.fg("dim", "/ or f search | up/down scroll | PgUp/PgDn | g/G | c clear search | q close"), width));
		out.push(truncateToWidth(`${this.searchMode ? "search>" : "filter:"} ${this.query || "(none)"} | ${lines.length}/${this.lines.length} lines | ${this.scroll + 1}-${Math.min(this.scroll + LOG_VIEW_ROWS, lines.length)}`, width));
		if (this.truncatedFromStart) out.push(truncateToWidth(this.theme.fg("warning", "tail truncated from start"), width));
		for (const line of visible) out.push(truncateToWidth(line, width));
		return out;
	}

	invalidate(): void {}

	private filteredLines(): string[] {
		if (!this.query) return this.lines;
		const needle = this.query.toLowerCase();
		return this.lines.filter((line) => line.toLowerCase().includes(needle));
	}

	private clampScroll(): void {
		const max = Math.max(0, this.filteredLines().length - LOG_VIEW_ROWS);
		this.scroll = Math.max(0, Math.min(this.scroll, max));
	}
}

class ProcessSettings implements Component {
	private list: SettingsList;

	constructor(
		private readonly manager: ProcessManager,
		private readonly theme: any,
		private readonly done: () => void,
		private readonly requestRender: () => void,
		private readonly onSettingsChanged: () => void,
	) {
		this.list = new SettingsList(this.items(), 12, settingsListTheme(theme), (id, value) => this.setValue(id, value), () => done(), { enableSearch: true });
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.requestRender();
	}

	render(width: number): string[] {
		const out: string[] = [];
		out.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(" background-tasks settings ")), width));
		out.push(truncateToWidth(this.theme.fg("borderMuted", "-".repeat(width)), width));
		out.push(...this.list.render(width));
		out.push(truncateToWidth(this.theme.fg("dim", "enter/space cycle | type to search | esc close"), width));
		return out;
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private items(): SettingItem[] {
		const config = this.manager.getConfig();
		return [
			{ id: "defaultBackend", label: "Default backend", currentValue: config.execution.defaultBackend, values: ["pipe", "pty", "tmux"], description: "Backend used when proc_start does not specify one." },
			{ id: "killOnReload", label: "Kill non-persistent on reload", currentValue: boolValue(config.execution.killOnReload), values: ["true", "false"], description: "Stop session-scoped tasks during /reload." },
			{ id: "killOnShutdown", label: "Kill non-persistent on shutdown", currentValue: boolValue(config.execution.killOnShutdown), values: ["true", "false"], description: "Stop session-scoped tasks when Pi exits." },
			{ id: "alertOnFailure", label: "Wake on failure by default", currentValue: boolValue(config.alerts.defaultAlertOnFailure), values: ["true", "false"], description: "Default alertOnFailure for new tasks." },
			{ id: "alertOnExit", label: "Wake on clean exit by default", currentValue: boolValue(config.alerts.defaultAlertOnExit), values: ["true", "false"], description: "Default alertOnExit for new tasks." },
			{ id: "dockEnabled", label: "Dock enabled", currentValue: boolValue(config.ui.dockEnabled), values: ["true", "false"], description: "Controls whether /proc:dock renders task lines." },
			{ id: "dockHeight", label: "Dock height", currentValue: String(config.ui.dockHeight), values: ["3", "5", "8", "10", "15"], description: "Maximum dock lines." },
		];
	}

	private setValue(id: string, value: string): void {
		const config = this.manager.getConfig();
		if (id === "defaultBackend" && isBackend(value)) config.execution.defaultBackend = value;
		else if (id === "killOnReload") config.execution.killOnReload = value === "true";
		else if (id === "killOnShutdown") config.execution.killOnShutdown = value === "true";
		else if (id === "alertOnFailure") config.alerts.defaultAlertOnFailure = value === "true";
		else if (id === "alertOnExit") config.alerts.defaultAlertOnExit = value === "true";
		else if (id === "dockEnabled") config.ui.dockEnabled = value === "true";
		else if (id === "dockHeight") config.ui.dockHeight = Number(value);
		this.list.updateValue(id, value);
		this.manager.notifySettingsChanged();
		this.onSettingsChanged();
	}
}

function formatListLabel(process: ManagedProcessInfo): string {
	const runtime = formatDuration((process.endedAt ?? Date.now()) - process.startedAt);
	const exit = process.exitCode === null ? "" : ` exit=${process.exitCode}`;
	const persisted = process.persistent ? " persistent" : "";
	return `${statusIcon(process.status)} ${process.name} ${runtime} [${process.status}]${persisted}${exit}`;
}

function shortCommand(process: ManagedProcessInfo, maxLength = 120): string {
	const command = process.command ?? process.argv?.join(" ") ?? "";
	return command.length <= maxLength ? command : `${command.slice(0, maxLength - 3)}...`;
}

function selectListTheme(theme: any): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

function settingsListTheme(theme: any): SettingsListTheme {
	return {
		label: (text, selected) => selected ? theme.fg("accent", text) : text,
		value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("muted", text),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", ">"),
		hint: (text) => theme.fg("dim", text),
	};
}

function statusIcon(status: ProcessStatus): string {
	if (status === "running" || status === "starting") return "*";
	if (status === "failed" || status === "kill_timeout" || status === "unknown" || status === "orphaned") return "x";
	if (status === "killing" || status === "signaled") return "!";
	return "o";
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function boolValue(value: boolean): string {
	return value ? "true" : "false";
}

function isBackend(value: string): value is "pipe" | "pty" | "tmux" {
	return value === "pipe" || value === "pty" || value === "tmux";
}
