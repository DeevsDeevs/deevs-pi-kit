import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Container, Editor, Key, matchesKey, SelectList, Spacer, Text, truncateToWidth, type Component, type Focusable, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { framePanelLines } from "../shared/panel.ts";

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
	timeoutMs?: number;
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

type AskMode = "select" | "freeform";
type DraftAnswer = { kind: "selection" | "freeform"; answer: string };
type MultiQuestionState = {
	mode: AskMode;
	answer?: DraftAnswer;
	freeformDraft: string;
	list?: SelectList;
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
	timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 30 * 60_000, description: "Optional dialog timeout" })),
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

class MultiAskOverlay implements Component, Focusable {
	focused = false;
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

	private ensureList(state: MultiQuestionState): SelectList {
		if (state.list) return state.list;
		const list = new SelectList(this.currentItems(), MAX_VISIBLE_OPTIONS, createSelectTheme(this.theme));
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
		if (state.editor) state.editor.focused = this.focused && state.mode === "freeform";
		const container = new Container();
		container.addChild(new Text(this.theme.fg("dim", `question ${this.currentIndex + 1}/${this.questions.length} · ${this.answeredCount()}/${this.questions.length} answered`), 1, 0));
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
			container.addChild(new Text(this.theme.fg("dim", this.currentItems().length > 0 ? "enter answer | esc options" : "enter answer | esc cancel"), 1, 0));
		} else {
			container.addChild(this.ensureList(state));
			container.addChild(new Text(this.theme.fg("dim", "left/right questions | up/down options | esc cancel | enter answer"), 1, 0));
		}
		const innerWidth = Math.max(1, width - 2);
		return framePanelLines("Ask User", container.render(innerWidth).map((line) => truncateToWidth(line, innerWidth)), this.theme, width);
	}

}

async function askMultiOverlay(ctx: ExtensionContext, questions: AskQuestionInput[], context: string | undefined, signal?: AbortSignal, timeoutMs?: number): Promise<AskAnswer[] | null> {
	let close: (() => void) | undefined;
	let cancelled = signal?.aborted ?? false;
	const abort = (): void => { cancelled = true; close?.(); };
	const timer = timeoutMs ? setTimeout(abort, timeoutMs) : undefined;
	signal?.addEventListener("abort", abort, { once: true });
	try {
		return await ctx.ui.custom<AskAnswer[] | null>(
		(tui, theme, _keybindings, done) => {
			close = () => done(null);
			if (cancelled) queueMicrotask(close);
			return new MultiAskOverlay(questions, context, tui, theme, done);
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				minWidth: 48,
				maxHeight: "85%",
				margin: 0,
			},
		},
		);
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

async function askNativeDialogs(ctx: ExtensionContext, questions: AskQuestionInput[], signal?: AbortSignal, timeoutMs?: number): Promise<AskAnswer[]> {
	const answers: AskAnswer[] = [];
	for (const question of questions) {
		if (signal?.aborted) break;
		const options = (question.options ?? []).map(normalizeOption);
		let answer: string | undefined;
		let kind: AnswerKind = "selection";
		if (options.length) {
			const labels = options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
			if (question.allowFreeform !== false) labels.push("Type custom response…");
			const selected = await ctx.ui.select(question.question, labels, { timeout: timeoutMs, signal });
			if (selected === "Type custom response…") {
				kind = "freeform";
				answer = await ctx.ui.input(question.question, "Type your answer", { timeout: timeoutMs, signal });
			} else if (selected) {
				answer = options[labels.indexOf(selected)]?.value ?? selected;
			}
		} else if (question.allowFreeform !== false) {
			kind = "freeform";
			answer = await ctx.ui.input(question.question, "Type your answer", { timeout: timeoutMs, signal });
		}
		answers.push({ id: question.id, question: question.question, answer: answer ?? null, kind: answer === undefined ? "cancelled" : kind, cancelled: answer === undefined });
		if (answer === undefined) break;
	}
	return answers;
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
			if (ctx.mode !== "tui") {
				answers.push(...await askNativeDialogs(ctx, questions, signal, params.timeoutMs));
			} else {
				const batchAnswers = await askMultiOverlay(ctx, questions, context, signal, params.timeoutMs);
				if (batchAnswers) answers.push(...batchAnswers);
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
