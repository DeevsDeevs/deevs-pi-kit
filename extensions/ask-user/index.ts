import { DynamicBorder, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type Theme, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Container, Editor, Key, matchesKey, Spacer, Text, truncateToWidth, wrapTextWithAnsi, type Component, type SelectItem, type TUI } from "@earendil-works/pi-tui";

type AskOptionInput = string | { title: string; description?: string };

type AskQuestionInput = {
	id?: string;
	question: string;
	options?: AskOptionInput[];
	allowFreeform?: boolean;
};

type AskUserInput = {
	context?: string;
	questions: AskQuestionInput[];
};

type AnswerKind = "selection" | "freeform" | "cancelled";

type AskAnswer = {
	id?: string;
	question: string;
	answer: string | null;
	kind: AnswerKind;
	cancelled: boolean;
};

type AskUserDetails = {
	context?: string;
	answers: AskAnswer[];
	cancelled: boolean;
	error?: string;
};

type OverlayResult = { kind: "selection" | "freeform"; answer: string } | null;
type AskMode = "select" | "freeform";
type DraftAnswer = { kind: "selection" | "freeform"; answer: string };
type MultiQuestionState = {
	mode: AskMode;
	answer?: DraftAnswer;
	freeformDraft: string;
	list?: AskOptionList;
	editor?: Editor;
};

const FREEFORM_VALUE = "__ask_user_freeform__";
const MAX_QUESTIONS = 5;
const MAX_VISIBLE_OPTIONS = 9;

const AskOptionSchema = Type.Union([
	Type.String({ description: "Short option title" }),
	Type.Object({
		title: Type.String({ description: "Short option title" }),
		description: Type.Optional(Type.String({ description: "Short trade-off or detail for this option" })),
	}),
]);

const AskQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable id for this question, useful when asking multiple clarifications" })),
	question: Type.String({ description: "One focused clarification or decision question" }),
	options: Type.Optional(Type.Array(AskOptionSchema, { description: "Optional single-select choices" })),
	allowFreeform: Type.Optional(Type.Boolean({ description: "Allow a typed answer. Default: true" })),
});

const AskUserSchema = Type.Object({
	context: Type.Optional(Type.String({ description: "Concise evidence/trade-off summary shown before the questions" })),
	questions: Type.Array(AskQuestionSchema, {
		description: "One to five focused clarification questions. Ask related questions together; do not ask what tools can answer.",
		minItems: 1,
		maxItems: MAX_QUESTIONS,
	}),
});

function normalizeOption(option: AskOptionInput): SelectItem {
	if (typeof option === "string") return { value: option, label: option };
	return { value: option.title, label: option.title, description: option.description };
}

function itemsForQuestion(question: AskQuestionInput): SelectItem[] {
	const allowFreeform = question.allowFreeform !== false;
	const options = (question.options ?? []).map(normalizeOption);
	return allowFreeform && options.length > 0
		? [...options, { value: FREEFORM_VALUE, label: "✎ Type custom response...", description: "Answer in your own words without leaving the overlay" }]
		: options;
}

function initialModeForQuestion(question: AskQuestionInput): AskMode {
	return (question.options?.length ?? 0) === 0 ? "freeform" : "select";
}

export function askQuestionNavigationTarget(currentIndex: number, questionCount: number, data: string): number | undefined {
	if (matchesKey(data, Key.left)) return Math.max(0, currentIndex - 1);
	if (matchesKey(data, Key.right)) return Math.min(Math.max(0, questionCount - 1), currentIndex + 1);
	return undefined;
}

export function askFreeformEscapeAction(hasOptions: boolean): "select" | "cancel" {
	return hasOptions ? "select" : "cancel";
}

function createSelectTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

function createEditorTheme(theme: Theme) {
	return {
		borderColor: (text: string) => theme.fg("accent", text),
		selectList: createSelectTheme(theme),
	};
}

function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data !== "\x7f";
}

function optionSearchText(item: SelectItem): string {
	return `${item.label} ${item.description ?? ""}`.toLowerCase();
}

function filterItems(items: SelectItem[], filter: string): SelectItem[] {
	const query = filter.trim().toLowerCase();
	if (!query) return items;
	const terms = query.split(/\s+/).filter(Boolean);
	return items.filter((item) => terms.every((term) => optionSearchText(item).includes(term)));
}

function wrapPlain(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [""];
	return wrapTextWithAnsi(normalized, Math.max(1, width));
}

class AskOptionList implements Component {
	private allItems: SelectItem[];
	private filteredItems: SelectItem[];
	private theme: Theme;
	private selectedIndex = 0;
	private filter = "";

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;

	constructor(items: SelectItem[], theme: Theme) {
		this.allItems = items;
		this.filteredItems = items;
		this.theme = theme;
	}

	invalidate(): void { }

	getFilter(): string {
		return this.filter;
	}

	private updateFilter(nextFilter: string): void {
		this.filter = nextFilter;
		this.filteredItems = filterItems(this.allItems, this.filter);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(Math.max(0, this.filteredItems.length - 1), this.selectedIndex + 1);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.selectedIndex = 0;
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.selectedIndex = Math.max(0, this.filteredItems.length - 1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) this.onSelect?.(item);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.filter) this.updateFilter("");
			else this.onCancel?.();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.updateFilter(this.filter.slice(0, -1));
			return;
		}
		if (isPrintable(data)) this.updateFilter(this.filter + data);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const titleWidth = Math.max(8, width - 6);
		const descriptionWidth = Math.max(8, width - 8);

		if (this.filter) lines.push(this.theme.fg("dim", `filter: ${this.filter}`));
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.fg("warning", "No matching options. Backspace to edit, esc to clear."));
			return lines.map((line) => truncateToWidth(line, width));
		}

		const windowStart = Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_OPTIONS / 2), this.filteredItems.length - MAX_VISIBLE_OPTIONS));
		const visible = this.filteredItems.slice(windowStart, windowStart + MAX_VISIBLE_OPTIONS);
		for (let offset = 0; offset < visible.length; offset += 1) {
			const item = visible[offset]!;
			const absoluteIndex = windowStart + offset;
			const selected = absoluteIndex === this.selectedIndex;
			const pointer = selected ? this.theme.fg("accent", "→") : " ";
			const titleStyle = selected ? (text: string) => this.theme.fg("accent", text) : (text: string) => this.theme.fg("text", text);
			const prefix = `${pointer} `;
			const titleLines = wrapPlain(item.label, titleWidth);
			for (let i = 0; i < titleLines.length; i += 1) {
				const linePrefix = i === 0 ? prefix : "  ";
				lines.push(truncateToWidth(`${linePrefix}${titleStyle(titleLines[i]!)}`, width));
			}
			if (item.description) {
				for (const descLine of wrapPlain(item.description, descriptionWidth).slice(0, 3)) {
					lines.push(truncateToWidth(`    ${this.theme.fg("muted", descLine)}`, width));
				}
			}
		}
		if (this.filteredItems.length > visible.length) lines.push(this.theme.fg("dim", `(${this.selectedIndex + 1}/${this.filteredItems.length})`));
		return lines.map((line) => truncateToWidth(line, width));
	}
}

class AskOverlay implements Component {
	private mode: AskMode;
	private title: string;
	private progress: string;
	private context: string | undefined;
	private items: SelectItem[];
	private theme: Theme;
	private tui: TUI;
	private done: (result: OverlayResult) => void;
	private list?: AskOptionList;
	private editor?: Editor;
	private freeformDraft = "";

	constructor(title: string, progress: string, context: string | undefined, items: SelectItem[], initialMode: AskMode, tui: TUI, theme: Theme, done: (result: OverlayResult) => void) {
		this.title = title;
		this.progress = progress;
		this.context = context;
		this.items = items;
		this.mode = initialMode;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	invalidate(): void {
		this.list?.invalidate();
		this.editor?.invalidate();
	}

	private ensureList(): AskOptionList {
		if (this.list) return this.list;
		const list = new AskOptionList(this.items, this.theme);
		list.onCancel = () => this.done(null);
		list.onSelect = (item) => {
			if (item.value === FREEFORM_VALUE) this.showFreeform();
			else this.done({ kind: "selection", answer: item.value });
		};
		this.list = list;
		return list;
	}

	private ensureEditor(): Editor {
		if (this.editor) return this.editor;
		const editor = new Editor(this.tui, createEditorTheme(this.theme));
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			if (trimmed) this.done({ kind: "freeform", answer: trimmed });
		};
		this.editor = editor;
		return editor;
	}

	private showFreeform(): void {
		this.mode = "freeform";
		const editor = this.ensureEditor();
		editor.setText(this.freeformDraft);
		this.invalidate();
		this.tui.requestRender();
	}

	private showSelect(): void {
		if (this.editor) this.freeformDraft = this.editor.getText();
		this.mode = "select";
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.mode === "freeform") {
			if (matchesKey(data, Key.escape)) {
				if (askFreeformEscapeAction(this.items.length > 0) === "select") this.showSelect();
				else this.done(null);
				return;
			}
			this.ensureEditor().handleInput(data);
			this.tui.requestRender();
			return;
		}
		this.ensureList().handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Ask User")) + this.theme.fg("dim", `  ${this.progress}`), 1, 0));
		container.addChild(new Text(this.theme.fg("text", this.theme.bold(this.title)), 1, 1));

		if (this.context) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatContext(this.context, this.theme), 1, 0));
		}

		container.addChild(new Spacer(1));
		if (this.mode === "freeform") {
			container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
			container.addChild(this.ensureEditor());
			container.addChild(new Text(this.theme.fg("dim", this.items.length > 0 ? "enter submit • esc options" : "enter submit • esc cancel"), 1, 0));
		} else {
			const list = this.ensureList();
			container.addChild(list);
			const filterHint = list.getFilter() ? "esc clear filter/cancel" : "type filter • esc cancel";
			container.addChild(new Text(this.theme.fg("dim", `↑↓ navigate • ${filterHint} • enter select`), 1, 0));
		}
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		return container.render(width).map((line) => truncateToWidth(line, width));
	}
}

class MultiAskOverlay implements Component {
	private questions: AskQuestionInput[];
	private context: string | undefined;
	private states: MultiQuestionState[];
	private currentIndex = 0;
	private theme: Theme;
	private tui: TUI;
	private done: (answers: AskAnswer[] | null) => void;

	constructor(questions: AskQuestionInput[], context: string | undefined, tui: TUI, theme: Theme, done: (answers: AskAnswer[] | null) => void) {
		this.questions = questions;
		this.context = context;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.states = questions.map((question) => ({ mode: initialModeForQuestion(question), freeformDraft: "" }));
	}

	invalidate(): void {
		for (const state of this.states) {
			state.list?.invalidate();
			state.editor?.invalidate();
		}
	}

	private currentQuestion(): AskQuestionInput {
		return this.questions[this.currentIndex]!;
	}

	private currentState(): MultiQuestionState {
		return this.states[this.currentIndex]!;
	}

	private currentItems(): SelectItem[] {
		return itemsForQuestion(this.currentQuestion());
	}

	private answeredCount(): number {
		return this.states.filter((state) => state.answer).length;
	}

	private toAnswers(cancelled = false): AskAnswer[] {
		return this.questions.map((question, index) => {
			const answer = this.states[index]?.answer;
			return {
				id: question.id,
				question: question.question,
				answer: answer?.answer ?? null,
				kind: answer?.kind ?? "cancelled",
				cancelled: cancelled || !answer,
			};
		});
	}

	private goTo(index: number): void {
		this.saveCurrentDraft();
		this.currentIndex = Math.max(0, Math.min(this.questions.length - 1, index));
		this.invalidate();
		this.tui.requestRender();
	}

	private saveCurrentDraft(): void {
		const state = this.currentState();
		if (state.editor) state.freeformDraft = state.editor.getText();
	}

	private firstUnansweredIndex(): number {
		return this.states.findIndex((state) => !state.answer);
	}

	private recordAnswer(kind: "selection" | "freeform", answer: string): void {
		this.currentState().answer = { kind, answer };
		if (this.answeredCount() === this.questions.length) {
			this.done(this.toAnswers(false));
			return;
		}
		const next = this.firstUnansweredIndex();
		this.goTo(next === -1 ? this.currentIndex : next);
	}

	private ensureList(state: MultiQuestionState): AskOptionList {
		if (state.list) return state.list;
		const list = new AskOptionList(this.currentItems(), this.theme);
		list.onCancel = () => this.done(null);
		list.onSelect = (item) => {
			if (item.value === FREEFORM_VALUE) this.showFreeform();
			else this.recordAnswer("selection", item.value);
		};
		state.list = list;
		return list;
	}

	private ensureEditor(state: MultiQuestionState): Editor {
		if (state.editor) return state.editor;
		const editor = new Editor(this.tui, createEditorTheme(this.theme));
		editor.disableSubmit = false;
		editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			if (trimmed) this.recordAnswer("freeform", trimmed);
		};
		state.editor = editor;
		return editor;
	}

	private showFreeform(): void {
		const state = this.currentState();
		state.mode = "freeform";
		const editor = this.ensureEditor(state);
		editor.setText(state.freeformDraft || state.answer?.answer || "");
		this.invalidate();
		this.tui.requestRender();
	}

	private showSelect(): void {
		const state = this.currentState();
		if (state.editor) state.freeformDraft = state.editor.getText();
		state.mode = "select";
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const state = this.currentState();
		if (state.mode === "select") {
			const nextIndex = askQuestionNavigationTarget(this.currentIndex, this.questions.length, data);
			if (nextIndex !== undefined) {
				this.goTo(nextIndex);
				return;
			}
			this.ensureList(state).handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (askFreeformEscapeAction(this.currentItems().length > 0) === "select") this.showSelect();
			else this.done(null);
			return;
		}
		this.ensureEditor(state).handleInput(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const question = this.currentQuestion();
		const state = this.currentState();
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Ask User")) + this.theme.fg("dim", `  question ${this.currentIndex + 1}/${this.questions.length} · ${this.answeredCount()}/${this.questions.length} answered`), 1, 0));
		container.addChild(new Text(this.progressLine(), 1, 0));
		container.addChild(new Text(this.theme.fg("text", this.theme.bold(question.question)), 1, 1));
		if (state.answer) container.addChild(new Text(`${this.theme.fg("success", "Current answer:")} ${this.theme.fg("accent", state.answer.answer)}`, 1, 0));

		if (this.context) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(formatContext(this.context, this.theme), 1, 0));
		}

		container.addChild(new Spacer(1));
		if (state.mode === "freeform") {
			container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
			container.addChild(this.ensureEditor(state));
			container.addChild(new Text(this.theme.fg("dim", this.currentItems().length > 0 ? "enter answer • esc options" : "enter answer • esc cancel"), 1, 0));
		} else {
			const list = this.ensureList(state);
			container.addChild(list);
			const filterHint = list.getFilter() ? "esc clear filter/cancel" : "type filter • esc cancel";
			container.addChild(new Text(this.theme.fg("dim", `←/→ questions • ↑↓ options • ${filterHint} • enter answer`), 1, 0));
		}
		container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
		return container.render(width).map((line) => truncateToWidth(line, width));
	}

	private progressLine(): string {
		return this.questions.map((_question, index) => {
			const label = String(index + 1);
			if (index === this.currentIndex) return this.theme.fg("accent", `[${label}]`);
			if (this.states[index]?.answer) return this.theme.fg("success", `✓${label}`);
			return this.theme.fg("dim", `○${label}`);
		}).join(" ");
	}
}

async function askMultiOverlay(ctx: ExtensionContext, questions: AskQuestionInput[], context: string | undefined): Promise<AskAnswer[] | null> {
	return ctx.ui.custom<AskAnswer[] | null>(
		(tui, theme, _keybindings, done) => new MultiAskOverlay(questions, context, tui, theme, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "92%",
				minWidth: 48,
				maxHeight: "85%",
				margin: 1,
			},
		},
	);
}

async function askOverlay(ctx: ExtensionContext, title: string, progress: string, context: string | undefined, items: SelectItem[], initialMode: AskMode): Promise<OverlayResult> {
	return ctx.ui.custom<OverlayResult>(
		(tui, theme, _keybindings, done) => new AskOverlay(title, progress, context, items, initialMode, tui, theme, done),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "92%",
				minWidth: 48,
				maxHeight: "85%",
				margin: 1,
			},
		},
	);
}

async function askOne(ctx: ExtensionContext, question: AskQuestionInput, index: number, total: number, context: string | undefined): Promise<AskAnswer> {
	const items = itemsForQuestion(question);
	const initialMode = initialModeForQuestion(question);
	const progress = total === 1 ? "" : `question ${index + 1}/${total}`;
	const result = await askOverlay(ctx, question.question, progress, context, items, initialMode);
	if (!result) return { id: question.id, question: question.question, answer: null, kind: "cancelled", cancelled: true };
	return { id: question.id, question: question.question, answer: result.answer, kind: result.kind, cancelled: false };
}

function formatContext(context: string, theme: Theme): string {
	return `${theme.fg("accent", theme.bold("Context"))}\n${theme.fg("muted", context)}`;
}

function summarizeAnswers(answers: AskAnswer[]): string {
	if (answers.length === 0) return "No answers collected.";
	return answers.map((answer, index) => `${index + 1}. ${answer.question}\n   → ${answer.answer ?? "cancelled"}`).join("\n");
}

function renderAnswer(answer: AskAnswer, theme: Theme): string {
	const icon = answer.cancelled ? theme.fg("warning", "!") : theme.fg("success", "✓");
	return `${icon} ${theme.fg("muted", answer.question)} ${theme.fg("accent", "→")} ${answer.answer ?? theme.fg("warning", "cancelled")}`;
}

export default function askUserExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user 1-5 focused clarification or decision questions in an interactive UI. Gather repo/docs/tool evidence first; do not ask questions you can answer yourself.",
		promptSnippet: "Ask the user focused clarification questions through an interactive UI.",
		promptGuidelines: [
			"Use ask_user when 1-5 concrete clarifications materially affect implementation, scope, safety, or acceptance criteria.",
			"When those conditions are met, call ask_user instead of asking clarification questions inline in normal chat.",
			"Before calling ask_user, gather available evidence from files, docs, commands, or prior context; do not ask questions tools can answer.",
			"Ask related clarification questions together in one call, but keep each question focused and decision-shaped.",
			"Prefer 2-5 short options with trade-off descriptions when there are clear choices; allow freeform when useful.",
			"If the user cancels or leaves a high-impact choice unanswered, stop and report what is blocked instead of assuming silently.",
		],
		parameters: AskUserSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: AskUserInput, signal, onUpdate, ctx): Promise<AgentToolResult<AskUserDetails>> {
			const questions = Array.isArray(params.questions) ? params.questions.slice(0, MAX_QUESTIONS) : [];
			const context = params.context?.trim() || undefined;
			if (questions.length === 0) {
				return {
					content: [{ type: "text" as const, text: "ask_user requires at least one question." }],
					details: { context, answers: [], cancelled: true, error: "No questions supplied" },
				};
			}

			if (signal?.aborted) return { content: [{ type: "text" as const, text: "ask_user cancelled." }], details: { context, answers: [], cancelled: true } };

			if (!ctx.hasUI || !ctx.ui) {
				const text = `Interactive UI is unavailable. Please answer:\n\n${questions.map((question, index) => `${index + 1}. ${question.question}`).join("\n")}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { context, answers: [], cancelled: true, error: "UI unavailable" },
				};
			}

			onUpdate?.({ content: [{ type: "text" as const, text: "Waiting for user clarification..." }], details: { context, answers: [], cancelled: false } });

			const answers: AskAnswer[] = [];
			if (questions.length > 1) {
				const batchAnswers = await askMultiOverlay(ctx, questions, context);
				if (batchAnswers) answers.push(...batchAnswers);
			} else {
				const answer = await askOne(ctx, questions[0]!, 0, 1, context);
				answers.push(answer);
			}

			const cancelled = answers.length === 0 || answers.some((answer) => answer.cancelled) || answers.length < questions.length;
			return {
				content: [{ type: "text" as const, text: cancelled ? `User clarification cancelled or incomplete:\n${summarizeAnswers(answers)}` : `User answered:\n${summarizeAnswers(answers)}` }],
				details: { context, answers, cancelled },
			};
		},
		renderCall(args: AskUserInput, theme: Theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			let text = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			if (args.questions?.[0]?.question) text += theme.fg("dim", ` — ${args.questions[0].question}`);
			return new Text(text, 0, 0);
		},
		renderResult(result: AgentToolResult<AskUserDetails | undefined>, { expanded }: ToolRenderResultOptions, theme: Theme) {
			const details = result.details;
			if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			if (details.error && details.answers.length === 0) return new Text(theme.fg("error", `ask_user: ${details.error}`), 0, 0);
			const prefix = details.cancelled ? theme.fg("warning", "Clarification incomplete") : theme.fg("success", "User clarified");
			const answers = expanded ? details.answers : details.answers.slice(0, 5);
			const lines = [prefix, ...answers.map((answer) => `  ${renderAnswer(answer, theme)}`)];
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
