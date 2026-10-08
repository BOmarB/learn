import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	isOther?: boolean;
	isSubmit?: boolean;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
	note?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
});

function normalizeOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
	note?: string,
) {
	return {
		status,
		question,
		context,
		mode,
		answers,
		message,
		note,
	} as AskUserQuestionResultDetails;
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function buildResult(question: string, context: string | undefined, mode: AskUserQuestionMode, answers: AskAnswer[], note?: string) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.trim().length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}
	if (note) text += `\nUser's note: ${note}`;

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context, undefined, note),
	};
}

// Persistent, always-present note field rendered under the options. Applies to
// ANY answer and is only surfaced to the agent when non-empty.
function pushNoteField(lines: string[], theme: any, width: number, editor: Editor, focused: boolean): void {
	lines.push("");
	const label = focused ? theme.fg("accent", "Note (optional):") : theme.fg("muted", "Note (optional):");
	addWrapped(lines, label, width, " ");
	for (const line of editor.render(width)) lines.push(line);
}

// Build the note Editor. `disableSubmit` is set because Enter must NOT submit
// here: the editor's submit path clears the buffer, which would wipe the note.
// Instead the host intercepts Enter to return focus to the options while
// keeping the text. Ctrl+J still inserts a newline (pi convention), so
// multi-line notes work.
function makeNoteEditor(tui: any, theme: any): Editor {
	const editor = new Editor(tui, createEditorTheme(theme));
	editor.focused = false;
	editor.disableSubmit = true;
	return editor;
}

async function askSingleChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<{ answer: AskAnswer; note?: string } | null> {
	const otherLabel = getOtherLabel(options);
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
	];

	return ctx.ui.custom<{ answer: AskAnswer; note?: string } | null>((tui: any, theme: any, _kb: any, done: (result: { answer: AskAnswer; note?: string } | null) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let focus: "options" | "note" = "options";
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const editor = new Editor(tui, createEditorTheme(theme));
		const noteEditor = makeNoteEditor(tui, theme);

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			done({ answer: { type: "other", label: trimmed, value: trimmed }, note: noteText() });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function noteText(): string | undefined {
			const t = noteEditor.getText().trim();
			return t.length ? t : undefined;
		}

		function toOptions() {
			focus = "options";
			noteEditor.focused = false;
			refresh();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Tab toggles focus between the options list and the note field.
			if (matchesKey(data, Key.tab)) {
				focus = focus === "options" ? "note" : "options";
				noteEditor.focused = focus === "note";
				refresh();
				return;
			}

			if (focus === "note") {
				// Enter and Esc both return to the options and keep the note text.
				// (Enter must be intercepted here: the editor's own submit clears
				// the buffer. Ctrl+J still reaches the editor as a newline.)
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
					toOptions();
					return;
				}
				noteEditor.handleInput(data);
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isOther) {
					editMode = true;
					editor.setText("");
					refresh();
					return;
				}
				done({
					answer: { type: "option", label: selected.label, value: selected.value, index: selected.index! },
					note: noteText(),
				});
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allOptions.length; i++) {
				const option = allOptions[i];
				const selected = i === optionIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
				const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
				add(`${prefix}${styled}`);
				if (option.description) {
					addWrapped(lines, theme.fg("muted", option.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to go back"));
			} else {
				pushNoteField(lines, theme, width, noteEditor, focus === "note");
				lines.push("");
				if (focus === "note") {
					add(theme.fg("dim", " Type note • Ctrl+J newline • Enter back to options • Tab options • Esc back"));
				} else {
					add(theme.fg("dim", " ↑↓ navigate • Enter select • Tab note • Esc cancel"));
				}
			}

			add(theme.fg("accent", "─".repeat(width)));
			// Not cached when the note is focused: the editor renders a live cursor.
			if (!editMode && focus !== "note") {
				cachedLines = lines;
				cachedWidth = width;
			}
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

async function askMultiChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<{ answers: AskAnswer[]; note?: string } | null> {
	const otherLabel = getOtherLabel(options);
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const submitItem: DisplayOption = { id: "submit", label: "Submit", value: "__submit__", isSubmit: true };
	const allItems: DisplayOption[] = [
		...choiceItems,
		{ id: "other", label: otherLabel, value: "__other__", isOther: true },
		submitItem,
	];

	return ctx.ui.custom<{ answers: AskAnswer[]; note?: string } | null>((tui: any, theme: any, _kb: any, done: (result: { answers: AskAnswer[]; note?: string } | null) => void) => {
		let optionIndex = 0;
		let editMode = false;
		let focus: "options" | "note" = "options";
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const selected = new Map<string, AskAnswer>();
		const editor = new Editor(tui, createEditorTheme(theme));
		const noteEditor = makeNoteEditor(tui, theme);

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			editMode = false;
			refresh();
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function noteText(): string | undefined {
			const t = noteEditor.getText().trim();
			return t.length ? t : undefined;
		}

		function toOptions() {
			focus = "options";
			noteEditor.focused = false;
			refresh();
		}

		function toggleOption(item: DisplayOption) {
			if (selected.has(item.id)) {
				selected.delete(item.id);
			} else {
				selected.set(item.id, {
					type: "option",
					label: item.label,
					value: item.value,
					index: item.index!,
				});
			}
			refresh();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText(selected.get("other")?.label || "");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Tab toggles focus between the options list and the note field.
			if (matchesKey(data, Key.tab)) {
				focus = focus === "options" ? "note" : "options";
				noteEditor.focused = focus === "note";
				refresh();
				return;
			}

			if (focus === "note") {
				// Enter and Esc both return to the options and keep the note text.
				// (Enter must be intercepted here: the editor's own submit clears
				// the buffer. Ctrl+J still reaches the editor as a newline.)
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
					toOptions();
					return;
				}
				noteEditor.handleInput(data);
				tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			const current = allItems[optionIndex];
			if (matchesKey(data, Key.space)) {
				if (current.isSubmit) return;
				if (current.isOther) {
					if (selected.has("other")) {
						selected.delete("other");
						refresh();
					} else {
						editMode = true;
						editor.setText("");
						refresh();
					}
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (current.isSubmit) {
					if (selected.size > 0) {
						done({ answers: sortAnswers(Array.from(selected.values())), note: noteText() });
					}
					return;
				}
				if (current.isOther) {
					editMode = true;
					editor.setText(selected.get("other")?.label || "");
					refresh();
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.escape)) {
				done(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allItems.length; i++) {
				const item = allItems[i];
				const isFocused = i === optionIndex;
				const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

				if (item.isSubmit) {
					const label = selected.size > 0 ? `✓ ${item.label} (${selected.size} selected)` : `○ ${item.label}`;
					const styled = isFocused
						? theme.fg("accent", label)
						: theme.fg(selected.size > 0 ? "success" : "dim", label);
					add(`${prefix}${styled}`);
					continue;
				}

				if (item.isOther) {
					const other = selected.get("other");
					const marker = other ? "[x]" : "[ ]";
					const suffix = other ? ` — ${other.label}` : "";
					const styled = isFocused
						? theme.fg("accent", `${marker} ${item.label}${suffix}`)
						: theme.fg(other ? "success" : "text", `${marker} ${item.label}${suffix}`);
					add(`${prefix}${styled}`);
					continue;
				}

				const checked = selected.has(item.id);
				const marker = checked ? "[x]" : "[ ]";
				const label = `${marker} ${item.index}. ${item.label}`;
				const styled = isFocused
					? theme.fg("accent", label)
					: theme.fg(checked ? "success" : "text", label);
				add(`${prefix}${styled}`);
				if (item.description) {
					addWrapped(lines, theme.fg("muted", item.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to save • Esc to go back"));
			} else {
				lines.push("");
				if (selected.size === 0) {
					add(theme.fg("warning", " Select at least one answer before submitting."));
				}
				pushNoteField(lines, theme, width, noteEditor, focus === "note");
				lines.push("");
				if (focus === "note") {
					add(theme.fg("dim", " Type note • Ctrl+J newline • Enter back to options • Tab options • Esc back"));
				} else {
					add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit • Tab note • Esc cancel"));
				}
			}

			add(theme.fg("accent", "─".repeat(width)));
			// Not cached when the note is focused: the editor renders a live cursor.
			if (!editMode && focus !== "note") {
				cachedLines = lines;
				cachedWidth = width;
			}
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

// Shared UI mutex. ctx.ui.custom()/editor can only handle one active call at
// a time, so ALL pop-up-style tools (ask_user_question, quiz, ...) must
// serialize against each other, not just against themselves. We stash one
// mutex on globalThis so separate extension files can share it without
// importing each other.
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const g = globalThis as any;
	if (!g[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => { release = r; });
				return prev.then(fn).finally(() => release!());
			},
		};
	}
	return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together. Prefer passing `options` whenever the possible answers can be enumerated — they render as a selectable list with an optional free-text note field; reserve the plain text mode for questions with no enumerable answers.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing. When options are shown, an always-present note field (Tab to focus) lets the user attach free-text context to any answer; it reaches you only when non-empty.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"If your question enumerates possible answers in prose (e.g. \"...e.g. A, B, C, or something else?\"), pass those choices as `options` instead of listing them in the question text — a prose enumeration hides the answer list from the picker and skips the note field. Plain text mode (no options) is only for questions whose answers genuinely cannot be enumerated.",
			"When options are shown, any answer may carry an optional free-text note the user typed in the always-present note field (Tab to focus it). When present, it reflects what the user was thinking or unsure about — read it and let it steer your follow-up. It is omitted entirely when empty.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = normalizeOptions(params.options);
			const context = params.details?.trim() || undefined;
			const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, context);
			}

			if (!ctx.hasUI) {
				return unavailableResult(params.question, mode, "ask_user_question requires interactive mode UI", context);
			}

			return withUILock(async () => {
				if (mode === "text") {
					const editorTitle = context ? `${params.question}\n\n${context}` : params.question;
					const answer = await ctx.ui.editor(editorTitle);
					if (answer === undefined) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [
						{ type: "text", label: answer.trim(), value: answer.trim() },
					]);
				}

				if (mode === "single-select") {
					const res = await askSingleChoice(ctx, params.question, context, options);
					if (!res) {
						return cancelledResult(params.question, mode, context);
					}
					return buildResult(params.question, context, mode, [res.answer], res.note);
				}

				const res = await askMultiChoice(ctx, params.question, context, options);
				if (!res) {
					return cancelledResult(params.question, mode, context);
				}
				return buildResult(params.question, context, mode, res.answers, res.note);
			});
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}

			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
				}
			});
			if (details.note) {
				for (const line of String(details.note).split("\n")) lines.push(theme.fg("muted", `Note: ${line}`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
