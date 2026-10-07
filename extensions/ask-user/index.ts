import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { Container, Editor, Key, matchesKey, SelectList, Spacer, Text, truncateToWidth, type Component, type Focusable, type SelectItem, type TUI } from "@earendil-works/pi-tui";
import { framePanelLines } from "../shared/panel.ts";
import { interactiveOnly } from "../shared/surface.ts";

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

type DraftAnswer = { kind: "selection" | "freeform"; answer: string };
type MultiQuestionState = {
	mode: "select" | "freeform";
	answer?: DraftAnswer;
	freeformDraft: string;
	list?: SelectList;
	editor?: Editor;
};

const FREEFORM_VALUE = "__ask_user_freeform__";
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
		maxItems: 5,
	}),
});

function normalizeOption(option: AskOptionInput): SelectItem {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- the schema admits a plain title or a {title, description} object.
	if (typeof option === "string") return { value: option, label: option };
	return { value: option.title, label: option.title, description: option.description };
}

function itemsForQuestion(question: AskQuestionInput): SelectItem[] {
	const options = (question.options ?? []).map(normalizeOption);
	return question.allowFreeform !== false && options.length > 0
		? [...options, { value: FREEFORM_VALUE, label: "✎ Type custom response...", description: "Answer in your own words without leaving the overlay" }]
		: options;
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

class MultiAskOverlay implements Component, Focusable {
	focused = false;
	private states: MultiQuestionState[];
	private currentIndex = 0;

	constructor(private questions: AskQuestionInput[], private context: string | undefined, private tui: TUI, private theme: Theme, private done: (answers: AskAnswer[] | null) => void) {
		this.states = questions.map((question) => ({ mode: question.options?.length ? "select" : "freeform", freeformDraft: "" }));
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

	private toAnswers(): AskAnswer[] {
		return this.questions.map((question, index) => {
			const answer = this.states[index]!.answer;
			return { id: question.id, question: question.question, answer: answer?.answer ?? null, kind: answer?.kind ?? "cancelled", cancelled: !answer };
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

	private recordAnswer(kind: "selection" | "freeform", answer: string): void {
		this.currentState().answer = { kind, answer };
		const next = this.states.findIndex((state) => !state.answer);
		if (next === -1) this.done(this.toAnswers());
		else this.goTo(next);
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
		const editor = new Editor(this.tui, { borderColor: (text: string) => this.theme.fg("accent", text), selectList: createSelectTheme(this.theme) });
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
		this.ensureEditor(state).setText(state.freeformDraft || state.answer?.answer || "");
		this.invalidate();
		this.tui.requestRender();
	}

	private showSelect(): void {
		this.saveCurrentDraft();
		this.currentState().mode = "select";
		this.invalidate();
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const state = this.currentState();
		if (state.mode === "select") {
			if (matchesKey(data, Key.left)) return this.goTo(this.currentIndex - 1);
			if (matchesKey(data, Key.right)) return this.goTo(this.currentIndex + 1);
			this.ensureList(state).handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (this.currentItems().length > 0) this.showSelect();
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
			container.addChild(new Text(`${this.theme.fg("accent", this.theme.bold("Context"))}\n${this.theme.fg("muted", this.context)}`, 1, 0));
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

async function askMultiOverlay(ctx: ExtensionContext, questions: AskQuestionInput[], context: string | undefined, signal?: AbortSignal): Promise<AskAnswer[] | null> {
	let close: (() => void) | undefined;
	let cancelled = signal?.aborted ?? false;
	const abort = (): void => { cancelled = true; close?.(); };
	signal?.addEventListener("abort", abort, { once: true });
	try {
		return await ctx.ui.custom<AskAnswer[] | null>(
			(tui, theme, _keybindings, done) => {
				close = () => done(null);
				if (cancelled) queueMicrotask(close);
				return new MultiAskOverlay(questions, context, tui, theme, done);
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "100%", minWidth: 48, maxHeight: "85%", margin: 0 } },
		);
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}

const CUSTOM_RESPONSE = "Type custom response…";

async function askNativeDialogs(ctx: ExtensionContext, questions: AskQuestionInput[], signal?: AbortSignal): Promise<AskAnswer[]> {
	const answers: AskAnswer[] = [];
	for (const question of questions) {
		if (signal?.aborted) break;
		const options = (question.options ?? []).map(normalizeOption);
		let answer: string | undefined;
		let kind: AnswerKind = "selection";
		if (options.length) {
			const labels = options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
			if (question.allowFreeform !== false) labels.push(CUSTOM_RESPONSE);
			const selected = await ctx.ui.select(question.question, labels, { signal });
			if (selected === CUSTOM_RESPONSE) {
				kind = "freeform";
				answer = await ctx.ui.input(question.question, "Type your answer", { signal });
			} else if (selected) {
				answer = options[labels.indexOf(selected)]?.value ?? selected;
			}
		} else if (question.allowFreeform !== false) {
			kind = "freeform";
			answer = await ctx.ui.input(question.question, "Type your answer", { signal });
		}
		answers.push({ id: question.id, question: question.question, answer: answer ?? null, kind: answer === undefined ? "cancelled" : kind, cancelled: answer === undefined });
		if (answer === undefined) break;
	}
	return answers;
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
			"Ask the user 1-5 focused questions about an irreversible or destructive choice in an interactive UI. Gather repo/docs/tool evidence first; do not ask questions you can answer yourself.",
		promptSnippet: "Ask the user before an irreversible or destructive step.",
		promptGuidelines: [
			"Anything short of irreversible or destructive: state the default you assume and continue. An answer typed in chat counts; after a cancelled dialog, do not take the step.",
		],
		parameters: AskUserSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: AskUserInput, signal, onUpdate, ctx): Promise<AgentToolResult<AskUserDetails>> {
			const { questions } = params;
			const context = params.context?.trim() || undefined;
			if (signal?.aborted) return { content: [{ type: "text" as const, text: "ask_user cancelled." }], details: { context, answers: [], cancelled: true } };

			if (!ctx.hasUI) {
				const text = `Interactive UI is unavailable. Please answer:\n\n${questions.map((question, index) => `${index + 1}. ${question.question}`).join("\n")}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { context, answers: [], cancelled: true, error: "UI unavailable" },
				};
			}

			onUpdate?.({ content: [{ type: "text" as const, text: "Waiting for user clarification..." }], details: { context, answers: [], cancelled: false } });

			const answers = ctx.mode === "tui" ? (await askMultiOverlay(ctx, questions, context, signal)) ?? [] : await askNativeDialogs(ctx, questions, signal);
			// An empty answer list never counts as answered: this tool gates destructive steps.
			const cancelled = answers.length === 0 || answers.length < questions.length || answers.some((answer) => answer.cancelled);
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
	interactiveOnly(pi, ["ask_user"]);
}
