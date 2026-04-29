import { Key, matchesKey, SelectList, SettingsList, truncateToWidth } from "@mariozechner/pi-tui";
import type { Component, SelectItem, SelectListTheme, SettingItem, SettingsListTheme } from "@mariozechner/pi-tui";
import type { SubagentManager } from "./manager.ts";
import type { AgentRunStatus } from "./types.ts";

const DOCK_ID = "subagents";

interface DockState {
	visible: boolean;
	component?: AgentsDock;
	requestRender?: () => void;
	unsubscribe?: () => void;
}

export function createSubagentsUi(manager: SubagentManager, onSettingsChanged?: (ctx: any) => void | Promise<void>) {
	const dock: DockState = { visible: false };
	return {
		showDock(ctx: any) {
			manager.settings.dockEnabled = true;
			void onSettingsChanged?.(ctx);
			if (dock.visible) {
				dock.requestRender?.();
				return;
			}
			dock.visible = true;
			ctx.ui.setWidget(DOCK_ID, (tui: any, theme: any) => {
				dock.requestRender = () => tui.requestRender();
				dock.component = new AgentsDock(manager, theme);
				return dock.component;
			}, { placement: "belowEditor" });
			dock.unsubscribe = manager.onChange(() => dock.requestRender?.());
		},
		hideDock(ctx: any) {
			manager.settings.dockEnabled = false;
			void onSettingsChanged?.(ctx);
			dock.unsubscribe?.();
			dock.unsubscribe = undefined;
			dock.visible = false;
			dock.component = undefined;
			dock.requestRender = undefined;
			ctx.ui.setWidget(DOCK_ID, undefined);
		},
		toggleDock(ctx: any) {
			if (dock.visible) this.hideDock(ctx);
			else this.showDock(ctx);
		},
		isDockVisible() {
			return dock.visible;
		},
		async showAgents(ctx: any) {
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new AgentsPanel(manager, theme, done, () => tui.requestRender()), { overlay: true, overlayOptions: { width: "88%", maxHeight: "82%", anchor: "center", margin: 1 } });
		},
		async showStatus(ctx: any) {
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new AgentStatusPanel(manager, ctx, theme, done, () => tui.requestRender()), { overlay: true, overlayOptions: { width: "90%", maxHeight: "82%", anchor: "center", margin: 1 } });
		},
		async showLogs(ctx: any, id: string, source?: any, raw?: boolean) {
			const result = await manager.logs({ id, source, raw });
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new TextViewer(`${result.source}: ${result.path ?? id}${raw ? " (raw)" : ""}`, result.content, theme, done, () => tui.requestRender()), { overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center", margin: 1 } });
		},
		async showSettings(ctx: any) {
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new AgentsSettingsPanel(manager, theme, done, () => tui.requestRender(), () => { void onSettingsChanged?.(ctx); }), { overlay: true, overlayOptions: { width: "72%", maxHeight: "80%", anchor: "center", margin: 1 } });
		},
	};
}

class AgentsDock implements Component {
	constructor(private readonly manager: SubagentManager, private readonly theme: any) {}
	render(width: number): string[] {
		const status = this.manager.status({ includeCompleted: false });
		const running = status.runs.filter((run) => run.status === "running" || run.status === "starting");
		if (running.length === 0) return [truncateToWidth(`${this.accent("subagents")}: ${this.muted("idle")}`, width)];
		const lines = [truncateToWidth(`${this.accent("subagents")}: ${running.length} running`, width)];
		for (const run of running.slice(0, Math.max(1, this.manager.settings.dockHeight - 1))) {
			lines.push(truncateToWidth(`* ${run.agent} ${formatDuration(Date.now() - run.startedAt)} ${run.id}`, width));
		}
		return lines;
	}
	invalidate(): void {}
	private accent(text: string): string { return this.theme?.fg ? this.theme.fg("accent", text) : text; }
	private muted(text: string): string { return this.theme?.fg ? this.theme.fg("muted", text) : text; }
}

class AgentsPanel implements Component {
	private list?: SelectList;
	constructor(private readonly manager: SubagentManager, private readonly theme: any, private readonly done: () => void, private readonly requestRender: () => void) {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return this.done();
		this.ensureList().handleInput(data);
		this.requestRender();
	}
	render(width: number): string[] {
		const selected = this.selectedAgent();
		const lines = [this.header(" curated staff ", width), this.dim("up/down select | q close", width), ""];
		lines.push(...this.ensureList().render(Math.floor(width * 0.42)).map((line) => truncateToWidth(line, width)));
		if (selected) {
			lines.push("", this.header(` ${selected.name} `, width));
			lines.push(truncateToWidth(selected.description, width));
			lines.push(this.dim(`tools=${selected.tools.join(",")} write=${selected.write ? "yes" : "no"} tags=${selected.tags.join(",")}`, width));
			lines.push("");
			lines.push(...selected.body.split(/\r?\n/).slice(0, 18).map((line) => truncateToWidth(line, width)));
		}
		return lines;
	}
	invalidate(): void { this.list?.invalidate(); }
	private ensureList(): SelectList {
		const items: SelectItem[] = this.manager.listAgents().map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
		if (!this.list) this.list = new SelectList(items, 10, selectListTheme(this.theme));
		return this.list;
	}
	private selectedAgent() { const value = this.ensureList().getSelectedItem()?.value; return value ? this.manager.listAgents().find((agent) => agent.name === value) : undefined; }
	private header(text: string, width: number): string { return truncateToWidth(this.theme.fg("accent", this.theme.bold(text)), width); }
	private dim(text: string, width: number): string { return truncateToWidth(this.theme.fg("dim", text), width); }
}

class AgentStatusPanel implements Component {
	private list?: SelectList;
	private listKey = "";
	private selectedId?: string;
	private unsubscribe?: () => void;
	constructor(private readonly manager: SubagentManager, private readonly ctx: any, private readonly theme: any, private readonly done: () => void, private readonly requestRender: () => void) {
		this.unsubscribe = manager.onChange(() => {
			this.invalidate();
			this.requestRender();
		});
	}
	handleInput(data: string): void {
		const id = this.ensureList().getSelectedItem()?.value;
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
			this.unsubscribe?.();
			return this.done();
		}
		if ((matchesKey(data, "r") || matchesKey(data, Key.enter)) && id) void this.read(id);
		else if (matchesKey(data, "l") && id) void this.logs(id);
		else if ((matchesKey(data, "s") || matchesKey(data, "k")) && id) void this.stop(id);
		else if (matchesKey(data, "c") && id) void this.clear(id);
		else this.ensureList().handleInput(data);
		this.selectedId = this.ensureList().getSelectedItem()?.value;
		this.requestRender();
	}
	render(width: number): string[] {
		const items = this.items();
		if (items.length === 0) {
			return [
				truncateToWidth(this.theme.fg("accent", this.theme.bold(" subagents status ")), width),
				truncateToWidth(this.theme.fg("dim", "no runs yet | use /agents:list or /agents:run <agent> -- <task> | q close"), width),
			];
		}
		return [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(" subagents status ")), width),
			truncateToWidth(this.theme.fg("dim", "up/down select | enter/r read | l logs | s/k stop | c clear | q close"), width),
			"",
			...this.ensureList(items).render(width),
		];
	}
	invalidate(): void { this.list?.invalidate(); this.listKey = ""; }
	private ensureList(items = this.items()): SelectList {
		const key = items.map((item) => item.value).join("\0");
		if (!this.list || key !== this.listKey) {
			this.list = new SelectList(items, 16, selectListTheme(this.theme));
			this.list.onSelectionChange = (item) => { this.selectedId = item.value; };
			const selectedIndex = items.findIndex((item) => item.value === this.selectedId);
			if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex);
			this.listKey = key;
		}
		return this.list;
	}
	private items(): SelectItem[] {
		const status = this.manager.status({ includeCompleted: true });
		return [
			...status.groups.map((group) => ({ value: group.id, label: `${group.id} [${group.status}] parallel ${group.children.length}`, description: `${formatDuration((group.endedAt ?? Date.now()) - group.startedAt)}` })),
			...status.runs.map((run) => ({ value: run.id, label: `${statusIcon(run.status)} ${run.id} [${run.status}] ${run.agent}`, description: run.task })),
		];
	}
	private async read(id: string): Promise<void> {
		await this.runAction(async () => {
			const result = await this.manager.read({ id });
			await this.showText(id, result.output || "(no output)");
		});
	}
	private async logs(id: string): Promise<void> {
		await this.runAction(async () => {
			const result = await this.manager.logs({ id });
			await this.showText(`${result.source}: ${result.path ?? id}`, result.content || "(empty)");
		});
	}
	private async stop(id: string): Promise<void> {
		await this.runAction(async () => {
			const result = await this.manager.stop({ id });
			this.ctx.ui.notify(`Stopped ${result.stopped.length} run(s). status=${result.status}`, "info");
		});
	}
	private async clear(id: string): Promise<void> {
		await this.runAction(async () => {
			const result = await this.manager.clear({ id });
			this.ctx.ui.notify(`Cleared ${result.cleared.length} record(s).`, "info");
		});
	}
	private async runAction(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			this.invalidate();
			this.requestRender();
		}
	}
	private async showText(title: string, content: string): Promise<void> {
		await this.ctx.ui.custom((tui: any, theme: any, _kb: any, done: () => void) => new TextViewer(title, content, theme, done, () => tui.requestRender()), { overlay: true, overlayOptions: { width: "92%", maxHeight: "85%", anchor: "center", margin: 1 } });
	}
}

class TextViewer implements Component {
	private scroll = 0;
	constructor(private readonly title: string, private readonly content: string, private readonly theme: any, private readonly done: () => void, private readonly requestRender: () => void) {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return this.done();
		if (matchesKey(data, Key.down)) this.scroll++;
		else if (matchesKey(data, Key.up)) this.scroll--;
		else if (matchesKey(data, "g")) this.scroll = 0;
		else if (matchesKey(data, "G")) this.scroll = this.lines().length;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.lines().length - 22)));
		this.requestRender();
	}
	render(width: number): string[] {
		return [truncateToWidth(this.theme.fg("accent", this.theme.bold(` ${this.title} `)), width), truncateToWidth(this.theme.fg("dim", "up/down scroll | g/G top/bottom | q close"), width), "", ...this.lines().slice(this.scroll, this.scroll + 24).map((line) => truncateToWidth(line, width))];
	}
	invalidate(): void {}
	private lines(): string[] { return this.content.split(/\r?\n/); }
}

class AgentsSettingsPanel implements Component {
	private list: SettingsList;
	constructor(private readonly manager: SubagentManager, private readonly theme: any, private readonly done: () => void, private readonly requestRender: () => void, private readonly onSettingsChanged: () => void) {
		this.list = new SettingsList(this.items(), 13, settingsListTheme(theme), (id, value) => this.setValue(id, value), () => done());
	}
	handleInput(data: string): void { this.list.handleInput(data); this.requestRender(); }
	render(width: number): string[] { return [truncateToWidth(this.theme.fg("accent", this.theme.bold(" subagents settings ")), width), ...this.list.render(width), truncateToWidth(this.theme.fg("dim", "enter/space cycle | esc close"), width)]; }
	invalidate(): void { this.list.invalidate(); }
	private items(): SettingItem[] {
		const s = this.manager.settings;
		return [
			{ id: "defaultTimeoutMs", label: "Default timeout", currentValue: String(s.defaultTimeoutMs), values: ["60000", "300000", "600000", "900000"], description: "Timeout for new agent runs." },
			{ id: "parallelDefaultConcurrency", label: "Default parallel concurrency", currentValue: String(s.parallelDefaultConcurrency), values: ["1", "2", "3", "4", "5", "6"], description: "Default parallel worker count." },
			{ id: "parallelMaxConcurrency", label: "Max parallel concurrency", currentValue: String(s.parallelMaxConcurrency), values: ["1", "2", "3", "4", "5", "6"], description: "Hard cap for this session." },
			{ id: "dockHeight", label: "Dock height", currentValue: String(s.dockHeight), values: ["3", "5", "6", "8", "10"], description: "Maximum dock lines for /agents:dock." },
			{ id: "defaultAllowWrite", label: "Default allow write", currentValue: bool(s.defaultAllowWrite), values: ["false", "true"], description: "Keep false unless you know why." },
			{ id: "notifyOnTerminal", label: "Notify on terminal", currentValue: bool(s.notifyOnTerminal), values: ["true", "false"], description: "Visible notifications for completion/failure." },
			{ id: "wakeOnCompletion", label: "Wake on completion", currentValue: bool(s.wakeOnCompletion), values: ["true", "false"], description: "Trigger parent turn on successful completions." },
			{ id: "wakeOnFailure", label: "Wake on failure", currentValue: bool(s.wakeOnFailure), values: ["true", "false"], description: "Trigger parent turn on failures." },
			{ id: "wakeOnTimeout", label: "Wake on timeout", currentValue: bool(s.wakeOnTimeout), values: ["true", "false"], description: "Trigger parent turn on timeouts." },
		];
	}
	private setValue(id: string, value: string): void {
		const s = this.manager.settings;
		if (id === "defaultTimeoutMs") s.defaultTimeoutMs = Number(value);
		else if (id === "parallelDefaultConcurrency") s.parallelDefaultConcurrency = Number(value);
		else if (id === "parallelMaxConcurrency") s.parallelMaxConcurrency = Number(value);
		else if (id === "dockHeight") s.dockHeight = Number(value);
		else if (id === "defaultAllowWrite") s.defaultAllowWrite = value === "true";
		else if (id === "notifyOnTerminal") s.notifyOnTerminal = value === "true";
		else if (id === "wakeOnCompletion") s.wakeOnCompletion = value === "true";
		else if (id === "wakeOnFailure") s.wakeOnFailure = value === "true";
		else if (id === "wakeOnTimeout") s.wakeOnTimeout = value === "true";
		this.list.updateValue(id, value);
		this.onSettingsChanged();
	}
}

function selectListTheme(theme: any): SelectListTheme { return { selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text), description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text) }; }
function settingsListTheme(theme: any): SettingsListTheme { return { label: (text, selected) => selected ? theme.fg("accent", text) : text, value: (text, selected) => selected ? theme.fg("accent", text) : theme.fg("muted", text), description: (text) => theme.fg("dim", text), cursor: theme.fg("accent", ">"), hint: (text) => theme.fg("dim", text) }; }
function bool(value: boolean): string { return value ? "true" : "false"; }
function statusIcon(status: AgentRunStatus): string { if (status === "running" || status === "starting") return "*"; if (status === "completed") return "o"; return "!"; }
function formatDuration(ms: number): string { const seconds = Math.max(0, Math.floor(ms / 1000)); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); return `${minutes}m${seconds % 60}s`; }
