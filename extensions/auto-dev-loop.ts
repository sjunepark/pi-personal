import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { agentCompaction } from "./agent-compaction.js";
import { POST_REVIEW_LOOP_START_EVENT, type PostReviewLoopStartRequest, type PostReviewLoopStartResult } from "./post-review-loop/events.js";
import {
	AUTO_DEV_ENTRY_TYPE,
	AUTO_DEV_MESSAGE_TYPE,
	AUTO_DEV_STATUS_KEY,
	autoDevEntry,
	createAutoDevState,
	latestAutoDevStateFromEntries,
	latestPostReviewLoopStateByIdFromEntries,
	latestPostReviewLoopStateFromEntries,
	parseAutoDevStartArgs,
	renderAutoDevCompactionRequestPrompt,
	renderBucketIIDecisionPrompt,
	renderBucketIIFollowupPrompt,
	renderClarificationFollowupPrompt,
	renderHandoffSummary,
	renderStatus,
	renderTaskPrompt,
	reviewScopeForTask,
	unresolvedBucketIIItems,
	updateAutoDevState,
	type AutoDevFollowupStatus,
	type AutoDevState,
	type AutoDevTaskStatus,
	type AutoDevTaskSummary,
	type AutoDevValidation,
} from "./shared/auto-dev-loop.js";

const COMPACT_MIN_TOKENS = 40_000;
const COMPACT_MIN_PERCENT = 50;

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean; terminate?: boolean };

type TaskResultParams = {
	status: AutoDevTaskStatus;
	title?: string;
	summary?: string;
	filesChanged?: string[];
	validation?: AutoDevValidation[];
	reviewScope?: string;
	questions?: string[];
	blocker?: string;
};

type BucketIIResultParams = {
	status: AutoDevFollowupStatus;
	summary?: string;
	changesMade?: boolean;
	filesChanged?: string[];
	validation?: AutoDevValidation[];
	questions?: string[];
	blocker?: string;
};

const ValidationStatusSchema = Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]);
const ValidationSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	result: ValidationStatusSchema,
	notes: Type.String({ minLength: 1 }),
});

const TaskResultSchema = Type.Object({
	status: Type.Union([Type.Literal("completed"), Type.Literal("needs_user"), Type.Literal("blocked"), Type.Literal("no_task")]),
	title: Type.Optional(Type.String({ description: "Short title of the selected task, or omitted when no task exists." })),
	summary: Type.Optional(Type.String({ description: "What changed, what was blocked, or why no task was available." })),
	filesChanged: Type.Optional(Type.Array(Type.String(), { description: "Files intentionally changed for the task." })),
	validation: Type.Optional(Type.Array(ValidationSchema)),
	reviewScope: Type.Optional(Type.String({ description: "Optional scope text for the post-review-loop." })),
	questions: Type.Optional(Type.Array(Type.String(), { description: "Required user questions when status is needs_user." })),
	blocker: Type.Optional(Type.String({ description: "Concrete blocker when status is blocked." })),
});

const BucketIIResultSchema = Type.Object({
	status: Type.Union([Type.Literal("completed"), Type.Literal("needs_user"), Type.Literal("blocked")]),
	summary: Type.Optional(Type.String({ description: "Result of applying or deciding Bucket II follow-up work." })),
	changesMade: Type.Optional(Type.Boolean({ description: "True when code or docs changed and need post-review-loop review." })),
	filesChanged: Type.Optional(Type.Array(Type.String(), { description: "Files intentionally changed for the Bucket II follow-up." })),
	validation: Type.Optional(Type.Array(ValidationSchema)),
	questions: Type.Optional(Type.Array(Type.String(), { description: "Remaining user questions when status is needs_user." })),
	blocker: Type.Optional(Type.String({ description: "Concrete blocker when status is blocked." })),
});

function sessionEntries(ctx: ExtensionContext): unknown[] {
	const manager = ctx.sessionManager as { getBranch?: () => unknown[]; getEntries?: () => unknown[] };
	return manager.getBranch?.() ?? manager.getEntries?.() ?? [];
}

function textToolResult(text: string, details?: unknown, isError = false, terminate = false): ToolTextResult {
	return { content: [{ type: "text", text }], details, isError, terminate };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function suppressNotifyDetails(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { notify: { suppressCompletion: true }, ...extra };
}

function unique(values: string[] | undefined): string[] {
	return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function validation(values: AutoDevValidation[] | undefined): AutoDevValidation[] {
	return (values ?? []).map((item) => ({ command: item.command.trim(), result: item.result, notes: item.notes.trim() })).filter((item) => item.command && item.notes);
}

function questions(values: string[] | undefined, fallback?: string): string[] {
	const cleaned = unique(values);
	if (cleaned.length) return cleaned;
	return fallback?.trim() ? [fallback.trim()] : [];
}

function compactText(value: string, max = 180): string {
	const clean = value.trim().replace(/\s+/g, " ");
	return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

export default function autoDevLoop(pi: ExtensionAPI): void {
	agentCompaction.register(pi);

	let state: AutoDevState | null = null;
	let scheduledPrompt: ReturnType<typeof setTimeout> | null = null;
	let promptScheduleVersion = 0;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(AUTO_DEV_STATUS_KEY, state && state.lifecycle !== "complete" ? `auto-dev: ${state.lifecycle} #${state.iteration}` : undefined);
	}

	function persist(ctx: ExtensionContext, event: string): void {
		pi.appendEntry(AUTO_DEV_ENTRY_TYPE, autoDevEntry(state, event));
		updateStatus(ctx);
	}

	function clearScheduledPrompt(): void {
		promptScheduleVersion += 1;
		if (!scheduledPrompt) return;
		clearTimeout(scheduledPrompt);
		scheduledPrompt = null;
	}

	function triggerPrompt(ctx: ExtensionContext, content: string, details: Record<string, unknown> = {}, display = false): void {
		clearScheduledPrompt();
		const version = promptScheduleVersion;
		const send = () => {
			if (version !== promptScheduleVersion) return;
			if (!ctx.isIdle()) {
				scheduledPrompt = setTimeout(send, 25);
				return;
			}
			scheduledPrompt = null;
			pi.sendMessage(
				{
					customType: AUTO_DEV_MESSAGE_TYPE,
					content,
					display,
					details: { source: "auto-dev-loop", stateId: state?.id, iteration: state?.iteration, ...details },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		};
		scheduledPrompt = setTimeout(send, 0);
	}

	function startTaskPrompt(ctx: ExtensionContext): void {
		if (!state) return;
		triggerPrompt(ctx, renderTaskPrompt(state), { phase: "task" });
	}

	function contextUsageRequiringBetweenTaskCompaction(ctx: ExtensionContext): ReturnType<ExtensionContext["getContextUsage"]> | undefined {
		if (!state?.compactBetweenTasks) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.percent === null) return undefined;
		return usage.tokens >= COMPACT_MIN_TOKENS || usage.percent >= COMPACT_MIN_PERCENT ? usage : undefined;
	}

	function continueAfterCompaction(ctx: ExtensionContext, expected: { stateId: string; iteration: number }): void {
		if (!state || state.id !== expected.stateId || state.iteration !== expected.iteration || state.lifecycle !== "active") return;
		startTaskPrompt(ctx);
	}

	function cancelPendingAutoDevCompaction(): void {
		agentCompaction.clearSource("auto-dev-loop:");
	}

	function runPhysicalCompactionFallback(ctx: ExtensionContext, compactionState: AutoDevState, expected: { stateId: string; iteration: number }, reason: string): void {
		notify(ctx, `Auto-dev-loop using built-in compaction fallback: ${reason}`, "warning");
		const version = promptScheduleVersion;
		const poll = () => {
			if (version !== promptScheduleVersion) return;
			if (!ctx.isIdle()) {
				setTimeout(poll, 25);
				return;
			}
			ctx.compact({
				customInstructions: renderHandoffSummary(compactionState),
				onComplete: () => continueAfterCompaction(ctx, expected),
				onError: (error) => {
					notify(ctx, `Auto-dev-loop compaction failed; continuing without compaction: ${error.message}`, "warning");
					continueAfterCompaction(ctx, expected);
				},
			});
		};
		setTimeout(poll, 0);
	}

	function requestBetweenTaskCompaction(ctx: ExtensionContext, usage: ReturnType<ExtensionContext["getContextUsage"]>): void {
		if (!state) return;
		const compactionState = state;
		const expected = { stateId: compactionState.id, iteration: compactionState.iteration };
		const requested = agentCompaction.request(pi, ctx, {
			source: "auto-dev-loop:between-task",
			message: renderAutoDevCompactionRequestPrompt(compactionState, usage),
			details: { phase: "between-task", usage, stateId: compactionState.id, iteration: compactionState.iteration },
			completionBehavior: "continue",
			onComplete: (_pi, completedCtx) => continueAfterCompaction(completedCtx, expected),
			onError: (_pi, failedCtx, error) => runPhysicalCompactionFallback(failedCtx, compactionState, expected, `agent-authored compaction failed: ${error.message}`),
		});

		if (!requested) runPhysicalCompactionFallback(ctx, compactionState, expected, "another agent-authored compaction request is already active");
	}

	function queueNextTask(ctx: ExtensionContext, message: string): void {
		if (!state) return;
		state = updateAutoDevState(state, {
			lifecycle: "active",
			iteration: state.iteration + 1,
			pendingBucketII: undefined,
			postReviewLoopId: undefined,
			handledPostReviewLoopId: undefined,
			awaiting: undefined,
			lastMessage: message,
		});
		persist(ctx, "next-task");

		const usage = contextUsageRequiringBetweenTaskCompaction(ctx);
		if (!usage) {
			startTaskPrompt(ctx);
			return;
		}
		requestBetweenTaskCompaction(ctx, usage);
	}

	function finishOrContinue(ctx: ExtensionContext, message: string): void {
		if (!state) return;
		if (state.once) {
			state = updateAutoDevState(state, { lifecycle: "complete", awaiting: undefined, lastMessage: message });
			persist(ctx, "completed-once");
			notify(ctx, `Auto-dev-loop completed one iteration: ${compactText(message)}`, "info");
			return;
		}
		queueNextTask(ctx, message);
	}

	function startPostReviewLoop(ctx: ExtensionContext, task: AutoDevTaskSummary, source: string): PostReviewLoopStartResult {
		let result: PostReviewLoopStartResult | undefined;
		const request: PostReviewLoopStartRequest = {
			ctx,
			scope: reviewScopeForTask(state!, task),
			limit: state!.reviewLimit,
			reviewOnly: false,
			gitCheckpoint: true,
			compact: false,
			source,
			onResult: (value) => {
				result = value;
			},
		};
		pi.events.emit(POST_REVIEW_LOOP_START_EVENT, request);
		return result ?? { ok: false, reason: "Post-review-loop start handler did not respond. Ensure the post-review-loop extension is loaded." };
	}

	function handleReviewCompletion(ctx: ExtensionContext): boolean {
		if (!state || state.lifecycle !== "reviewing") return false;
		const loop = latestPostReviewLoopStateFromEntries(sessionEntries(ctx));
		if (!loop) {
			state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: "Tracked post-review-loop state was cleared or cancelled." });
			persist(ctx, "post-review-loop-missing");
			notify(ctx, "Auto-dev-loop paused because its post-review-loop state was cleared or cancelled.", "warning");
			return true;
		}
		if (loop.id !== state.postReviewLoopId) {
			state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: `Tracked post-review-loop was replaced by ${loop.id}.` });
			persist(ctx, "post-review-loop-replaced");
			notify(ctx, "Auto-dev-loop paused because another post-review-loop replaced the tracked review.", "warning");
			return true;
		}
		if (loop.lifecycle === "failed") {
			state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: "Post-review-loop failed; inspect /post-review-loop report before continuing." });
			persist(ctx, "post-review-loop-failed");
			notify(ctx, "Auto-dev-loop paused because post-review-loop failed.", "warning");
			return true;
		}
		if (loop.lifecycle !== "complete") return false;
		if (state.handledPostReviewLoopId === loop.id) return true;

		const unresolved = unresolvedBucketIIItems(loop);
		if (unresolved.length) {
			state = updateAutoDevState(state, {
				lifecycle: "awaiting_bucket_ii",
				pendingBucketII: unresolved,
				handledPostReviewLoopId: loop.id,
				awaiting: { kind: "bucket_ii", questions: unresolved.map((item) => item.title) },
				lastMessage: `${unresolved.length} Bucket II decision item(s) need user approval.`,
			});
			persist(ctx, "awaiting-bucket-ii");
			triggerPrompt(ctx, renderBucketIIDecisionPrompt(state, unresolved), { phase: "bucket-ii-decision", postReviewLoopId: loop.id });
			return true;
		}

		state = updateAutoDevState(state, { pendingBucketII: undefined, handledPostReviewLoopId: loop.id, awaiting: undefined });
		persist(ctx, "post-review-loop-clean");
		finishOrContinue(ctx, "Post-review-loop finished cleanly with no unresolved Bucket II decisions.");
		return true;
	}

	function restore(ctx: ExtensionContext): void {
		state = latestAutoDevStateFromEntries(sessionEntries(ctx));
		updateStatus(ctx);
	}

	pi.registerCommand("auto-dev", {
		description: "Run an autonomous task -> post-review-loop -> Bucket II decision loop",
		getArgumentCompletions(prefix) {
			const options = [
				"start",
				"start --once",
				"start --review-limit 3",
				"once",
				"status",
				"pause",
				"resume",
				"stop",
				"clear",
				"answer ",
				"bucket2 ",
			];
			const filtered = options.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcommand = "status"] = trimmed ? trimmed.split(/\s+/, 2) : ["status"];
			const restText = trimmed && trimmed.includes(" ") ? trimmed.slice(trimmed.indexOf(" ") + 1) : "";

			if (subcommand === "status") {
				restore(ctx);
				ctx.ui.notify(renderStatus(state), "info");
				return;
			}

			if (subcommand === "clear") {
				state = null;
				persist(ctx, "cleared");
				clearScheduledPrompt();
				cancelPendingAutoDevCompaction();
				ctx.ui.notify("Auto-dev-loop state cleared.", "info");
				return;
			}

			if (subcommand === "pause") {
				if (!state || state.lifecycle === "complete") {
					ctx.ui.notify("No active auto-dev-loop to pause.", "warning");
					return;
				}
				state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: "Paused by user." });
				persist(ctx, "paused");
				clearScheduledPrompt();
				cancelPendingAutoDevCompaction();
				ctx.ui.notify("Auto-dev-loop paused. Use /auto-dev resume to continue.", "info");
				return;
			}

			if (subcommand === "stop") {
				if (!state) {
					ctx.ui.notify("No auto-dev-loop state.", "info");
					return;
				}
				state = updateAutoDevState(state, { lifecycle: "complete", lastMessage: "Stopped by user." });
				persist(ctx, "stopped");
				clearScheduledPrompt();
				cancelPendingAutoDevCompaction();
				ctx.ui.notify("Auto-dev-loop stopped.", "info");
				return;
			}

			if (subcommand === "resume") {
				if (!state) {
					ctx.ui.notify("No auto-dev-loop state to resume. Use /auto-dev start.", "warning");
					return;
				}
				if (state.lifecycle === "awaiting_user") {
					ctx.ui.notify("Auto-dev-loop is waiting for an answer. Use /auto-dev answer <answer>.", "warning");
					return;
				}
				if (state.lifecycle === "awaiting_bucket_ii") {
					ctx.ui.notify("Auto-dev-loop is waiting for a Bucket II decision. Use /auto-dev bucket2 <decision>.", "warning");
					return;
				}
				if (state.lifecycle === "reviewing") {
					if (!handleReviewCompletion(ctx)) ctx.ui.notify("Auto-dev-loop is waiting for post-review-loop to finish.", "info");
					return;
				}
				state = updateAutoDevState(state, { lifecycle: "active", lastMessage: "Resumed by user." });
				persist(ctx, "resumed");
				startTaskPrompt(ctx);
				return;
			}

			if (subcommand === "answer") {
				if (!state || state.lifecycle !== "awaiting_user") {
					ctx.ui.notify("Auto-dev-loop is not waiting for a task clarification.", "warning");
					return;
				}
				if (!restText.trim()) {
					ctx.ui.notify("Usage: /auto-dev answer <answer>", "warning");
					return;
				}
				const prompt = renderClarificationFollowupPrompt(state, restText);
				state = updateAutoDevState(state, { lifecycle: "active", awaiting: undefined, lastMessage: "User answered task clarification." });
				persist(ctx, "task-clarification-answered");
				triggerPrompt(ctx, prompt, { phase: "task-clarification" });
				return;
			}

			if (subcommand === "bucket2") {
				if (!state || state.lifecycle !== "awaiting_bucket_ii") {
					ctx.ui.notify("Auto-dev-loop is not waiting for Bucket II decisions.", "warning");
					return;
				}
				if (!restText.trim()) {
					ctx.ui.notify("Usage: /auto-dev bucket2 <decision>", "warning");
					return;
				}
				const unresolved = state.pendingBucketII?.length ? state.pendingBucketII : unresolvedBucketIIItems(latestPostReviewLoopStateByIdFromEntries(sessionEntries(ctx), state.postReviewLoopId));
				if (!unresolved.length) {
					finishOrContinue(ctx, "No unresolved Bucket II items remain.");
					return;
				}
				const prompt = renderBucketIIFollowupPrompt(state, restText, unresolved);
				state = updateAutoDevState(state, { lifecycle: "applying_bucket_ii", awaiting: undefined, lastMessage: "User answered Bucket II decision request." });
				persist(ctx, "bucket-ii-answered");
				triggerPrompt(ctx, prompt, { phase: "bucket-ii-followup" });
				return;
			}

			if (subcommand === "start" || subcommand === "once") {
				if (state && state.lifecycle !== "complete") {
					const ok = await ctx.ui.confirm("Replace active auto-dev-loop?", renderStatus(state));
					if (!ok) return;
				}
				try {
					cancelPendingAutoDevCompaction();
					const parsed = parseAutoDevStartArgs(restText, { once: subcommand === "once" });
					state = createAutoDevState(parsed);
					persist(ctx, "started");
					ctx.ui.notify(`Auto-dev-loop started${state.once ? " for one iteration" : ""}.`, "info");
					startTaskPrompt(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
				return;
			}

			ctx.ui.notify("Usage: /auto-dev start|once|status|pause|resume|stop|clear|answer|bucket2", "warning");
		},
	});

	pi.registerTool({
		name: "auto_dev_task_result",
		label: "Auto Dev Task Result",
		description: "Report the selected auto-dev task outcome. The extension starts post-review-loop after completed tasks.",
		promptSnippet: "Finish each auto-dev task by reporting completed, needs_user, blocked, or no_task.",
		promptGuidelines: [
			"Use this only when the auto-dev-loop prompt asks for it.",
			"Ask users only for product policy, contract, user intent, taste, missing access, or destructive decisions; decide ordinary technical details yourself.",
			"Do not manually start post-review-loop after a completed task; this tool lets the extension do it.",
		],
		parameters: TaskResultSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: TaskResultParams, _signal, _onUpdate, ctx) {
			if (!state || (state.lifecycle !== "active" && state.lifecycle !== "awaiting_user")) {
				return textToolResult("No active auto-dev-loop task is expecting a result.", { state }, true);
			}

			const title = params.title?.trim() || (params.status === "no_task" ? "No task available" : "Untitled auto-dev task");
			const task: AutoDevTaskSummary = {
				title,
				summary: params.summary?.trim() || params.blocker?.trim() || "No summary provided.",
				filesChanged: unique(params.filesChanged),
				validation: validation(params.validation),
				reviewScope: params.reviewScope?.trim() || undefined,
			};

			if (params.status === "needs_user") {
				const qs = questions(params.questions, params.blocker);
				state = updateAutoDevState(state, {
					lifecycle: "awaiting_user",
					lastTask: task,
					awaiting: { kind: "task_clarification", questions: qs },
					lastMessage: qs.length ? "Task clarification needed." : "Task needs user input.",
				});
				persist(ctx, "awaiting-user");
				return textToolResult(`Auto-dev-loop is waiting for user input.\n${qs.map((q) => `- ${q}`).join("\n") || "No question text was provided."}`, { state }, false, true);
			}

			if (params.status === "blocked") {
				state = updateAutoDevState(state, { lifecycle: "paused", lastTask: task, awaiting: undefined, lastMessage: params.blocker?.trim() || "Task blocked." });
				persist(ctx, "task-blocked");
				return textToolResult(`Auto-dev-loop paused: ${state.lastMessage}`, { state }, false, true);
			}

			if (params.status === "no_task") {
				state = updateAutoDevState(state, { lifecycle: "complete", lastTask: task, awaiting: undefined, lastMessage: task.summary });
				persist(ctx, "no-task");
				return textToolResult("Auto-dev-loop completed: no actionable task was found.", { state }, false, true);
			}

			state = updateAutoDevState(state, { lifecycle: "reviewing", lastTask: task, awaiting: undefined, lastMessage: "Task completed; post-review-loop starting." });
			persist(ctx, "task-completed");
			const result = startPostReviewLoop(ctx, task, "auto-dev-loop");
			if (!result.ok) {
				state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: `Could not start post-review-loop: ${result.reason}` });
				persist(ctx, "post-review-loop-start-failed");
				return textToolResult(state.lastMessage ?? result.reason, { state }, true, true);
			}
			state = updateAutoDevState(state, { pendingBucketII: undefined, postReviewLoopId: result.state.id, lastMessage: "Post-review-loop is reviewing the completed task." });
			persist(ctx, "post-review-loop-started");
			return textToolResult("Task result accepted. Post-review-loop has been started; stop substantial work until its prompts continue.", suppressNotifyDetails({ state }), false, true);
		},
	});

	pi.registerTool({
		name: "auto_dev_bucket2_result",
		label: "Auto Dev Bucket II Result",
		description: "Report the outcome of user-approved Bucket II follow-up work.",
		promptSnippet: "After the user answers Bucket II decisions, report whether follow-up completed, needs more user input, or is blocked.",
		promptGuidelines: [
			"Use only after auto-dev-loop asks you to apply or resolve Bucket II decisions.",
			"Apply only work that the user clearly approved; ask again when the decision is ambiguous.",
			"When changes were made, this tool lets the extension start post-review-loop for those changes.",
		],
		parameters: BucketIIResultSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: BucketIIResultParams, _signal, _onUpdate, ctx) {
			if (!state || state.lifecycle !== "applying_bucket_ii") {
				return textToolResult("No Bucket II follow-up is expecting a result.", { state }, true);
			}

			if (params.status === "needs_user") {
				const qs = questions(params.questions, params.blocker);
				state = updateAutoDevState(state, {
					lifecycle: "awaiting_bucket_ii",
					awaiting: { kind: "bucket_ii", questions: qs },
					lastMessage: qs.length ? "Bucket II clarification needed." : "Bucket II decision needs more user input.",
				});
				persist(ctx, "bucket-ii-needs-user");
				return textToolResult(`Auto-dev-loop is waiting for Bucket II input.\n${qs.map((q) => `- ${q}`).join("\n") || "No question text was provided."}`, { state }, false, true);
			}

			if (params.status === "blocked") {
				state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: params.blocker?.trim() || "Bucket II follow-up blocked." });
				persist(ctx, "bucket-ii-blocked");
				return textToolResult(`Auto-dev-loop paused: ${state.lastMessage}`, { state }, false, true);
			}

			const task: AutoDevTaskSummary = {
				title: "Bucket II follow-up",
				summary: params.summary?.trim() || "Bucket II follow-up completed.",
				filesChanged: unique(params.filesChanged),
				validation: validation(params.validation),
				reviewScope: params.filesChanged?.length ? `auto-dev Bucket II follow-up. Files changed: ${unique(params.filesChanged).join(", ")}.` : "auto-dev Bucket II follow-up",
			};

			if (params.changesMade === true || task.filesChanged.length > 0) {
				state = updateAutoDevState(state, { lifecycle: "reviewing", lastTask: task, awaiting: undefined, lastMessage: "Bucket II follow-up changed files; post-review-loop starting." });
				persist(ctx, "bucket-ii-changes-completed");
				const result = startPostReviewLoop(ctx, task, "auto-dev-loop Bucket II follow-up");
				if (!result.ok) {
					state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: `Could not start post-review-loop: ${result.reason}` });
					persist(ctx, "post-review-loop-start-failed");
					return textToolResult(state.lastMessage ?? result.reason, { state }, true, true);
				}
				state = updateAutoDevState(state, { pendingBucketII: undefined, postReviewLoopId: result.state.id, handledPostReviewLoopId: undefined, lastMessage: "Post-review-loop is reviewing Bucket II follow-up changes." });
				persist(ctx, "post-review-loop-started");
				return textToolResult("Bucket II follow-up accepted. Post-review-loop has been started for the follow-up changes.", suppressNotifyDetails({ state }), false, true);
			}

			state = updateAutoDevState(state, { lastTask: task, pendingBucketII: undefined, awaiting: undefined, lastMessage: task.summary });
			persist(ctx, "bucket-ii-no-changes-completed");
			finishOrContinue(ctx, "Bucket II decisions completed without code changes.");
			return textToolResult("Bucket II decisions completed without code changes.", suppressNotifyDetails({ state }), false, true);
		},
	});

	pi.on("session_start", (event, ctx) => {
		clearScheduledPrompt();
		restore(ctx);
		if (!state || state.lifecycle === "complete") return;
		if (event.reason === "reload" && (state.lifecycle === "active" || state.lifecycle === "applying_bucket_ii")) {
			state = updateAutoDevState(state, { lifecycle: "paused", lastMessage: "Paused after reload." });
			persist(ctx, "reload-paused");
			notify(ctx, "Auto-dev-loop paused after reload. Use /auto-dev resume to continue.", "info");
			return;
		}
		if (state.lifecycle === "active" && ctx.isIdle()) startTaskPrompt(ctx);
		if (state.lifecycle === "reviewing") handleReviewCompletion(ctx);
		if (state.lifecycle === "awaiting_user") notify(ctx, "Auto-dev-loop is waiting for /auto-dev answer <answer>.", "info");
		if (state.lifecycle === "awaiting_bucket_ii") notify(ctx, "Auto-dev-loop is waiting for /auto-dev bucket2 <decision>.", "info");
	});

	pi.on("agent_end", (_event, ctx) => {
		handleReviewCompletion(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || event.text.trim().startsWith("/")) return { action: "continue" };
		if (!state || !event.text.trim()) return { action: "continue" };

		if (state.lifecycle === "awaiting_user") {
			const prompt = renderClarificationFollowupPrompt(state, event.text);
			state = updateAutoDevState(state, { lifecycle: "active", awaiting: undefined, lastMessage: "User answered task clarification." });
			persist(ctx, "task-clarification-answered");
			triggerPrompt(ctx, prompt, { phase: "task-clarification" });
			return { action: "handled" };
		}

		if (state.lifecycle === "awaiting_bucket_ii") {
			const unresolved = state.pendingBucketII?.length ? state.pendingBucketII : unresolvedBucketIIItems(latestPostReviewLoopStateByIdFromEntries(sessionEntries(ctx), state.postReviewLoopId));
			if (!unresolved.length) {
				finishOrContinue(ctx, "No unresolved Bucket II items remain.");
				return { action: "handled" };
			}
			const prompt = renderBucketIIFollowupPrompt(state, event.text, unresolved);
			state = updateAutoDevState(state, { lifecycle: "applying_bucket_ii", awaiting: undefined, lastMessage: "User answered Bucket II decision request." });
			persist(ctx, "bucket-ii-answered");
			triggerPrompt(ctx, prompt, { phase: "bucket-ii-followup" });
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	pi.on("session_tree", (_event, ctx) => {
		clearScheduledPrompt();
		cancelPendingAutoDevCompaction();
		restore(ctx);
	});

	pi.on("session_shutdown", () => {
		clearScheduledPrompt();
		cancelPendingAutoDevCompaction();
	});
}
