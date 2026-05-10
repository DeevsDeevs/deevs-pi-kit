import { Key, matchesKey, SelectList, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, SelectItem, SelectListTheme, SettingItem, SettingsListTheme } from "@earendil-works/pi-tui";
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
	const clearDock = (ctx?: any) => {
		dock.unsubscribe?.();
		dock.unsubscribe = undefined;
		dock.visible = false;
		dock.component = undefined;
		dock.requestRender = undefined;
		ctx?.ui?.setWidget(DOCK_ID, undefined);
	};
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
			clearDock(ctx);
		},
		dispose(ctx?: any) {
			clearDock(ctx);
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

export function renderAgentsDockLines(manager: Pick<SubagentManager, "settings" | "status">, theme?: any, width = Number.POSITIVE_INFINITY): string[] {
	const status = manager.status({ includeCompleted: false });
	const running = status.runs.filter((run) => run.status === "running" || run.status === "starting");
	const accent = (text: string) => theme?.fg ? theme.fg("accent", text) : text;
	const muted = (text: string) => theme?.fg ? theme.fg("muted", text) : text;
	if (running.length === 0) return [truncateToWidth(`${accent("subagents")}: ${muted("idle")}`, width)];
	const maxRows = Math.max(1, manager.settings.dockHeight - 1);
	const lines = [truncateToWidth(`${accent("subagents")}: ${running.length} running`, width)];
	for (const run of running.slice(0, maxRows)) {
		lines.push(truncateToWidth(`* ${run.agent} ${formatDuration(Date.now() - run.startedAt)} ${run.id}`, width));
	}
	if (running.length > maxRows) lines.push(truncateToWidth(`... ${running.length - maxRows} more`, width));
	return lines;
}

class AgentsDock implements Component {
	constructor(private readonly manager: SubagentManager, private readonly theme: any) {}
	render(width: number): string[] {
		return renderAgentsDockLines(this.manager, this.theme, width);
	}
	invalidate(): void {}
}

export function subagentAgentItems(agents: Array<{ name: string; description: string }>): SelectItem[] {
	return agents.map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
}

export function renderSubagentAgentPreviewLines(agent: { name: string; description: string; tools: string[]; write: boolean; tags: string[]; body: string } | undefined, theme: any, width: number): string[] {
	if (!agent) return [truncateToWidth(theme.fg("dim", "No agent selected."), width)];
	return [
		truncateToWidth(theme.fg("accent", theme.bold(` ${agent.name} `)), width),
		truncateToWidth(agent.description, width),
		truncateToWidth(theme.fg("dim", `tools=${agent.tools.join(",")} write=${agent.write ? "yes" : "no"} tags=${agent.tags.join(",")}`), width),
		"",
		...agent.body.split(/\r?\n/).slice(0, 18).map((line) => truncateToWidth(line, width)),
	];
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
		if (selected) lines.push("", ...renderSubagentAgentPreviewLines(selected, this.theme, width));
		return lines;
	}
	invalidate(): void { this.list?.invalidate(); }
	private ensureList(): SelectList {
		const items = subagentAgentItems(this.manager.listAgents());
		if (!this.list) this.list = new SelectList(items, 10, selectListTheme(this.theme));
		return this.list;
	}
	private selectedAgent() { const value = this.ensureList().getSelectedItem()?.value; return value ? this.manager.listAgents().find((agent) => agent.name === value) : undefined; }
	private header(text: string, width: number): string { return truncateToWidth(this.theme.fg("accent", this.theme.bold(text)), width); }
	private dim(text: string, width: number): string { return truncateToWidth(this.theme.fg("dim", text), width); }
}

export function subagentStatusItems(status: { groups: any[]; runs: any[] }): SelectItem[] {
	return [
		...status.groups.map((group) => ({ value: group.id, label: `${group.id} [${group.status}] parallel ${group.children.length}`, description: `${formatDuration((group.endedAt ?? Date.now()) - group.startedAt)}` })),
		...status.runs.map((run) => ({ value: run.id, label: `${statusIcon(run.status)} ${run.id} [${run.status}] ${run.agent}`, description: run.task })),
	];
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
		return subagentStatusItems(this.manager.status({ includeCompleted: true }));
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

export interface SubagentTextViewerRenderInput {
	title: string;
	content: string;
	scroll: number;
	theme: any;
	width: number;
}

export function subagentTextViewerLines(content: string): string[] {
	const lines = content.replace(/\n$/, "").split(/\r?\n/);
	return lines.length === 1 && lines[0] === "" ? ["(empty)"] : lines;
}

export function renderSubagentTextViewerLines(input: SubagentTextViewerRenderInput): string[] {
	const lines = subagentTextViewerLines(input.content);
	const maxScroll = Math.max(0, lines.length - 22);
	const scroll = Math.max(0, Math.min(input.scroll, maxScroll));
	return [
		truncateToWidth(input.theme.fg("accent", input.theme.bold(` ${input.title} `)), input.width),
		truncateToWidth(input.theme.fg("dim", "up/down scroll | g/G top/bottom | q close"), input.width),
		truncateToWidth(input.theme.fg("dim", `${scroll + 1}-${Math.min(scroll + 24, lines.length)} / ${lines.length}`), input.width),
		"",
		...lines.slice(scroll, scroll + 24).map((line) => truncateToWidth(line, input.width)),
	];
}

class TextViewer implements Component {
	private scroll = 0;
	constructor(private readonly title: string, private readonly content: string, private readonly theme: any, private readonly done: () => void, private readonly requestRender: () => void) {}
	handleInput(data: string): void {
		const lines = subagentTextViewerLines(this.content);
		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return this.done();
		if (matchesKey(data, Key.down)) this.scroll++;
		else if (matchesKey(data, Key.up)) this.scroll--;
		else if (matchesKey(data, "g")) this.scroll = 0;
		else if (matchesKey(data, Key.shift("g"))) this.scroll = lines.length;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - 22)));
		this.requestRender();
	}
	render(width: number): string[] {
		return renderSubagentTextViewerLines({ title: this.title, content: this.content, scroll: this.scroll, theme: this.theme, width });
	}
	invalidate(): void {}
}

export function subagentSettingsItems(s: SubagentManager["settings"]): SettingItem[] {
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

class AgentsSettingsPanel implements Component {
	private list: SettingsList;
	constructor(private readonly manager: SubagentManager, private readonly theme: any, private readonly done: () => void, private readonly requestRender: () => void, private readonly onSettingsChanged: () => void) {
		this.list = new SettingsList(this.items(), 13, settingsListTheme(theme), (id, value) => this.setValue(id, value), () => done());
	}
	handleInput(data: string): void { this.list.handleInput(data); this.requestRender(); }
	render(width: number): string[] { return [truncateToWidth(this.theme.fg("accent", this.theme.bold(" subagents settings ")), width), ...this.list.render(width), truncateToWidth(this.theme.fg("dim", "enter/space cycle | esc close"), width)]; }
	invalidate(): void { this.list.invalidate(); }
	private items(): SettingItem[] {
		return subagentSettingsItems(this.manager.settings);
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
