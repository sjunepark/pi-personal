import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { POST_REVIEW_LOOP_START_EVENT, type PostReviewLoopStartRequest, type PostReviewLoopStartResult } from "./post-review-loop/events.js";
import { DESIGN_SIGNALS } from "./post-review-loop/types.js";
import {
	AUTO_REVIEW_DECISIONS_FILE,
	AUTO_REVIEW_ENTRY_TYPE,
	AUTO_REVIEW_LEDGER_DIR,
	AUTO_REVIEW_LEDGER_FILE,
	AUTO_REVIEW_MESSAGE_TYPE,
	AUTO_REVIEW_STATE_FILE,
	AUTO_REVIEW_STATUS_KEY,
	actionableBucketIItems,
	autoReviewEntry,
	createAutoReviewState,
	latestAutoReviewStateFromEntries,
	latestPostReviewLoopStateByIdFromEntries,
	markReviewSliceCompleted,
	parseAutoReviewStartArgs,
	renderFindingDecisionPrompt,
	renderFindingFollowupPrompt,
	renderGenericDecisionFollowupPrompt,
	renderLedgerState,
	renderPostReviewDecisionPrompt,
	renderReviewPrompt,
	renderStatus,
	reviewScopeForResult,
	selectNextReviewSlice,
	unresolvedBucketIIItems,
	updateAutoReviewState,
	normalizeAutoReviewDesignSignal,
	type AutoReviewFinding,
	type AutoReviewResultStatus,
	type AutoReviewResultSummary,
	type AutoReviewSlice,
	type AutoReviewState,
	type AutoReviewValidation,
} from "./shared/auto-review-loop.js";

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean; terminate?: boolean };

type ReviewResultParams = {
	status: AutoReviewResultStatus;
	summary?: string;
	filesReviewed?: string[];
	filesChanged?: string[];
	validation?: AutoReviewValidation[];
	findings?: AutoReviewFinding[];
	questions?: string[];
	blocker?: string;
};

const ValidationStatusSchema = Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]);
const ValidationSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	result: ValidationStatusSchema,
	notes: Type.String({ minLength: 1 }),
});

const DesignSignalSchema = Type.Union(DESIGN_SIGNALS.map((signal) => Type.Literal(signal)));

const FindingSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	tier: Type.Union([Type.Literal("auto_fix"), Type.Literal("ask_user"), Type.Literal("record_only")]),
	designSignal: DesignSignalSchema,
	summary: Type.String({ minLength: 1 }),
	files: Type.Array(Type.String()),
	recommendedAction: Type.String({ minLength: 1 }),
	status: Type.Union([Type.Literal("found"), Type.Literal("fixed"), Type.Literal("deferred"), Type.Literal("kept")]),
	userQuestion: Type.Optional(Type.String()),
});

const ReviewResultSchema = Type.Object({
	status: Type.Union([Type.Literal("clean"), Type.Literal("fixed"), Type.Literal("needs_user"), Type.Literal("blocked"), Type.Literal("no_target")]),
	summary: Type.Optional(Type.String({ description: "What was reviewed, fixed, blocked, or decided." })),
	filesReviewed: Type.Optional(Type.Array(Type.String(), { description: "Files actually inspected." })),
	filesChanged: Type.Optional(Type.Array(Type.String(), { description: "Files intentionally changed by this review iteration." })),
	validation: Type.Optional(Type.Array(ValidationSchema)),
	findings: Type.Optional(Type.Array(FindingSchema)),
	questions: Type.Optional(Type.Array(Type.String(), { description: "Questions for the user when status is needs_user." })),
	blocker: Type.Optional(Type.String({ description: "Concrete blocker when status is blocked or needs_user." })),
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

function unique(values: string[] | undefined): string[] {
	return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function validation(values: AutoReviewValidation[] | undefined): AutoReviewValidation[] {
	return (values ?? []).map((item) => ({ command: item.command.trim(), result: item.result, notes: item.notes.trim() })).filter((item) => item.command && item.notes);
}

function findings(values: AutoReviewFinding[] | undefined): AutoReviewFinding[] {
	return (values ?? [])
		.map((item) => ({
			...item,
			title: item.title.trim(),
			summary: item.summary.trim(),
			designSignal: normalizeAutoReviewDesignSignal(String(item.designSignal)),
			files: unique(item.files),
			recommendedAction: item.recommendedAction.trim(),
			userQuestion: item.userQuestion?.trim() || undefined,
		}))
		.filter((item) => item.title && item.summary && item.recommendedAction);
}

function questions(values: string[] | undefined, fallbackFindings: AutoReviewFinding[], fallback?: string): string[] {
	const explicit = unique(values);
	if (explicit.length) return explicit;
	const fromFindings = unique(fallbackFindings.map((item) => item.userQuestion ?? ""));
	if (fromFindings.length) return fromFindings;
	return fallback?.trim() ? [fallback.trim()] : [];
}

function compactText(value: string, max = 180): string {
	const clean = value.trim().replace(/\s+/g, " ");
	return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function gitValue(cwd: string, command: string): string | undefined {
	try {
		return execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function gitContext(ctx: ExtensionContext): Record<string, unknown> {
	return {
		branch: gitValue(ctx.cwd, "git rev-parse --abbrev-ref HEAD"),
		head: gitValue(ctx.cwd, "git rev-parse --short HEAD"),
		upstream: gitValue(ctx.cwd, "git rev-parse --abbrev-ref --symbolic-full-name @{u}"),
		status: gitValue(ctx.cwd, "git status --short --untracked-files=all"),
	};
}

type BranchFreshness = {
	branch?: string;
	head?: string;
	upstream?: string;
	ahead: number;
	behind: number;
};

function branchFreshness(ctx: ExtensionContext): BranchFreshness | undefined {
	const upstream = gitValue(ctx.cwd, "git rev-parse --abbrev-ref --symbolic-full-name @{u}");
	if (!upstream) return undefined;
	const counts = gitValue(ctx.cwd, "git rev-list --left-right --count HEAD...@{u}");
	const [aheadText = "0", behindText = "0"] = counts?.split(/\s+/) ?? [];
	return {
		branch: gitValue(ctx.cwd, "git rev-parse --abbrev-ref HEAD"),
		head: gitValue(ctx.cwd, "git rev-parse --short HEAD"),
		upstream,
		ahead: Number.parseInt(aheadText, 10) || 0,
		behind: Number.parseInt(behindText, 10) || 0,
	};
}

function renderBranchCheckpointPrompt(freshness: BranchFreshness): string {
	const relation = freshness.ahead && freshness.behind ? `diverged (${freshness.ahead} ahead, ${freshness.behind} behind)` : freshness.behind ? `${freshness.behind} behind` : `${freshness.ahead} ahead`;
	return `Auto-review reached a safe checkpoint and the branch is not fresh with its upstream.

Branch: ${freshness.branch ?? "unknown"}
Upstream: ${freshness.upstream ?? "unknown"}
Status: ${relation}

Reply normally, or use /auto-review answer <decision>.

Options:
1. continue reviewing current branch
2. pause for manual branch sync
3. approve merge/rebase handling now
4. show/discuss branch status

No merge or rebase will run unless you explicitly approve it.`;
}

function ledgerDir(ctx: ExtensionContext): string {
	return join(ctx.cwd, AUTO_REVIEW_LEDGER_DIR);
}

function persistLedger(ctx: ExtensionContext, state: AutoReviewState | null, event: string, extra: Record<string, unknown> = {}): void {
	if (!state) return;
	try {
		const dir = ledgerDir(ctx);
		mkdirSync(dir, { recursive: true });
		const entry = { version: 1, at: new Date().toISOString(), event, git: gitContext(ctx), state: renderLedgerState(state), ...extra };
		writeFileSync(join(dir, AUTO_REVIEW_STATE_FILE), `${JSON.stringify(entry, null, 2)}\n`);
		appendFileSync(join(dir, AUTO_REVIEW_LEDGER_FILE), `${JSON.stringify(entry)}\n`);
		if (state.awaiting?.questions.length) {
			appendFileSync(join(dir, AUTO_REVIEW_DECISIONS_FILE), `\n## ${new Date().toISOString()} — ${event}\n\n${state.awaiting.questions.map((question) => `- ${question}`).join("\n")}\n`);
		}
	} catch {
		// Session persistence is authoritative for the extension. Ledger write
		// failures should not stop the user's active Pi workflow.
	}
}

function suppressNotifyDetails(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { notify: { suppressCompletion: true }, ...extra };
}

export default function autoReviewLoop(pi: ExtensionAPI): void {
	let state: AutoReviewState | null = null;
	let scheduledPrompt: ReturnType<typeof setTimeout> | null = null;
	let promptScheduleVersion = 0;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(AUTO_REVIEW_STATUS_KEY, state && state.lifecycle !== "complete" ? `auto-review: ${state.lifecycle} #${state.iteration}` : undefined);
	}

	function persist(ctx: ExtensionContext, event: string, extra: Record<string, unknown> = {}): void {
		pi.appendEntry(AUTO_REVIEW_ENTRY_TYPE, autoReviewEntry(state, event));
		persistLedger(ctx, state, event, extra);
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
					customType: AUTO_REVIEW_MESSAGE_TYPE,
					content,
					display,
					details: { source: "auto-review-loop", stateId: state?.id, iteration: state?.iteration, ...details },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		};
		scheduledPrompt = setTimeout(send, 0);
	}

	function startReviewPrompt(ctx: ExtensionContext): void {
		if (!state) return;
		const slice = selectNextReviewSlice(state);
		if (!slice) {
			state = updateAutoReviewState(state, { lifecycle: "complete", lastMessage: "All configured review slices are complete." });
			persist(ctx, "all-slices-complete");
			notify(ctx, "Auto-review-loop completed all configured review slices.", "info");
			return;
		}
		state = updateAutoReviewState(state, { lifecycle: "active_reviewing", lastSlice: slice, awaiting: undefined, pendingFindings: undefined, lastMessage: "Review prompt queued." });
		persist(ctx, "review-started", { slice });
		triggerPrompt(ctx, renderReviewPrompt(state, slice), { phase: "review", slice });
	}

	function finishOrContinue(ctx: ExtensionContext, message: string): void {
		if (!state) return;
		if (state.once || state.iteration >= state.reviewLimit) {
			state = updateAutoReviewState(state, { lifecycle: "complete", awaiting: undefined, lastMessage: message });
			persist(ctx, state.once ? "completed-once" : "review-limit-complete");
			notify(ctx, `Auto-review-loop completed: ${compactText(message)}`, "info");
			return;
		}
		const freshness = branchFreshness(ctx);
		if (freshness && (freshness.behind > 0 || (freshness.ahead > 0 && freshness.behind > 0)) && freshness.head && state.lastBranchPromptHead !== freshness.head) {
			state = updateAutoReviewState(state, {
				lifecycle: "awaiting_user",
				lastBranchPromptHead: freshness.head,
				awaiting: {
					kind: "branch_decision",
					questions: [`Branch ${freshness.branch ?? "current"} is ${freshness.ahead} ahead and ${freshness.behind} behind ${freshness.upstream ?? "upstream"}. Continue, pause, or approve merge/rebase handling?`],
					findings: [],
				},
				lastMessage: "Branch freshness decision needed before the next review slice.",
			});
			persist(ctx, "awaiting-branch-decision", { branch: freshness });
			triggerPrompt(ctx, renderBranchCheckpointPrompt(freshness), { phase: "branch-checkpoint", branch: freshness });
			return;
		}

		state = updateAutoReviewState(state, {
			lifecycle: "active_reviewing",
			iteration: state.iteration + 1,
			postReviewLoopId: undefined,
			handledPostReviewLoopId: undefined,
			pendingFindings: undefined,
			awaiting: undefined,
			lastMessage: message,
		});
		persist(ctx, "next-review");
		startReviewPrompt(ctx);
	}

	function startPostReviewLoop(ctx: ExtensionContext, resultSummary: AutoReviewResultSummary): PostReviewLoopStartResult {
		let result: PostReviewLoopStartResult | undefined;
		const request: PostReviewLoopStartRequest = {
			ctx,
			scope: reviewScopeForResult(state!, resultSummary),
			limit: state!.reviewLimit,
			reviewOnly: false,
			gitCheckpoint: true,
			compact: false,
			source: "auto-review-loop",
			onResult: (value) => {
				result = value;
			},
		};
		pi.events.emit(POST_REVIEW_LOOP_START_EVENT, request);
		return result ?? { ok: false, reason: "Post-review-loop start handler did not respond. Ensure the post-review-loop extension is loaded." };
	}

	function handleReviewCompletion(ctx: ExtensionContext): boolean {
		if (!state || state.lifecycle !== "self_reviewing") return false;
		const loop = latestPostReviewLoopStateByIdFromEntries(sessionEntries(ctx), state.postReviewLoopId);
		if (!loop) {
			state = updateAutoReviewState(state, { lifecycle: "paused", lastMessage: "Tracked post-review-loop state was cleared, cancelled, or not found." });
			persist(ctx, "post-review-loop-missing");
			notify(ctx, "Auto-review-loop paused because its tracked post-review-loop is missing.", "warning");
			return true;
		}
		if (loop.lifecycle === "failed") {
			state = updateAutoReviewState(state, { lifecycle: "paused", lastMessage: "Post-review-loop failed; inspect /post-review-loop report before continuing." });
			persist(ctx, "post-review-loop-failed");
			notify(ctx, "Auto-review-loop paused because post-review-loop failed.", "warning");
			return true;
		}
		if (loop.lifecycle !== "complete") return false;
		if (state.handledPostReviewLoopId === loop.id) return true;

		const bucketII = unresolvedBucketIIItems(loop);
		const bucketI = actionableBucketIItems(loop);
		if (bucketII.length || bucketI.length) {
			const questions = [
				...bucketI.map((item) => `Self-review Bucket I: ${item.title} — ${item.fix}`),
				...bucketII.map((item) => `Self-review Bucket II: ${item.title} — ${item.recommendedAction}`),
			];
			state = updateAutoReviewState(state, {
				lifecycle: "awaiting_user",
				handledPostReviewLoopId: loop.id,
				awaiting: { kind: "finding_decision", questions, findings: [] },
				lastMessage: `${bucketI.length + bucketII.length} self-review item(s) need user input.`,
			});
			persist(ctx, "awaiting-self-review-decision", { bucketI, bucketII });
			triggerPrompt(ctx, renderPostReviewDecisionPrompt(state, bucketI, bucketII), { phase: "self-review-decision", postReviewLoopId: loop.id });
			return true;
		}

		if (state.lastSlice) state = markReviewSliceCompleted(state, state.lastSlice);
		state = updateAutoReviewState(state, { handledPostReviewLoopId: loop.id, awaiting: undefined, pendingFindings: undefined, lastMessage: "Self-review finished cleanly." });
		persist(ctx, "post-review-loop-clean");
		finishOrContinue(ctx, "Auto-review fix passed post-review-loop with no remaining decisions.");
		return true;
	}

	function restore(ctx: ExtensionContext): void {
		state = latestAutoReviewStateFromEntries(sessionEntries(ctx));
		updateStatus(ctx);
	}

	function handleUserDecision(ctx: ExtensionContext, answer: string): void {
		if (!state || state.lifecycle !== "awaiting_user") return;
		const cleanAnswer = answer.trim();
		if (state.awaiting?.kind === "branch_decision") {
			if (/^(1|continue|proceed|keep going|ignore)\b/i.test(cleanAnswer)) {
				state = updateAutoReviewState(state, { lifecycle: "active_reviewing", awaiting: undefined, lastMessage: "User chose to continue reviewing the current branch." });
				persist(ctx, "branch-continue", { answer: cleanAnswer });
				finishOrContinue(ctx, "Continuing on the current branch after user approval.");
				return;
			}
			if (/^(2|pause|stop|manual)\b/i.test(cleanAnswer)) {
				state = updateAutoReviewState(state, { lifecycle: "paused", awaiting: undefined, lastMessage: "Paused for manual branch sync." });
				persist(ctx, "branch-paused", { answer: cleanAnswer });
				notify(ctx, "Auto-review-loop paused for manual branch sync.", "info");
				return;
			}
		}

		const prompt = state.pendingFindings?.length
			? renderFindingFollowupPrompt(state, cleanAnswer, state.pendingFindings)
			: renderGenericDecisionFollowupPrompt(state, cleanAnswer);
		state = updateAutoReviewState(state, { lifecycle: "active_reviewing", awaiting: undefined, lastMessage: "User answered auto-review decision request." });
		persist(ctx, "decision-answered", { answer: cleanAnswer });
		triggerPrompt(ctx, prompt, { phase: "decision-followup" });
	}

	pi.registerCommand("auto-review", {
		description: "Run a ledger-driven autonomous code review loop",
		getArgumentCompletions(prefix) {
			const options = ["start", "start --once", "start --review-limit 3", "start --dimensions correctness,structure", "once", "status", "pause", "resume", "stop", "clear", "answer "];
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
				ctx.ui.notify("Auto-review-loop state cleared.", "info");
				return;
			}

			if (subcommand === "pause") {
				if (!state || state.lifecycle === "complete") {
					ctx.ui.notify("No active auto-review-loop to pause.", "warning");
					return;
				}
				state = updateAutoReviewState(state, { lifecycle: "paused", lastMessage: "Paused by user." });
				persist(ctx, "paused");
				clearScheduledPrompt();
				ctx.ui.notify("Auto-review-loop paused. Use /auto-review resume to continue.", "info");
				return;
			}

			if (subcommand === "stop") {
				if (!state) {
					ctx.ui.notify("No auto-review-loop state.", "info");
					return;
				}
				state = updateAutoReviewState(state, { lifecycle: "complete", lastMessage: "Stopped by user." });
				persist(ctx, "stopped");
				clearScheduledPrompt();
				ctx.ui.notify("Auto-review-loop stopped.", "info");
				return;
			}

			if (subcommand === "resume") {
				if (!state) {
					ctx.ui.notify("No auto-review-loop state to resume. Use /auto-review start.", "warning");
					return;
				}
				if (state.lifecycle === "awaiting_user") {
					ctx.ui.notify("Auto-review-loop is waiting for an answer. Use /auto-review answer <decision> or reply normally.", "warning");
					return;
				}
				if (state.lifecycle === "self_reviewing") {
					if (!handleReviewCompletion(ctx)) ctx.ui.notify("Auto-review-loop is waiting for post-review-loop to finish.", "info");
					return;
				}
				state = updateAutoReviewState(state, { lifecycle: "active_reviewing", lastMessage: "Resumed by user." });
				persist(ctx, "resumed");
				startReviewPrompt(ctx);
				return;
			}

			if (subcommand === "answer") {
				if (!state || state.lifecycle !== "awaiting_user") {
					ctx.ui.notify("Auto-review-loop is not waiting for a decision.", "warning");
					return;
				}
				if (!restText.trim()) {
					ctx.ui.notify("Usage: /auto-review answer <decision>", "warning");
					return;
				}
				handleUserDecision(ctx, restText);
				return;
			}

			if (subcommand === "start" || subcommand === "once") {
				if (state && state.lifecycle !== "complete") {
					const ok = await ctx.ui.confirm("Replace active auto-review-loop?", renderStatus(state));
					if (!ok) return;
				}
				try {
					const parsed = parseAutoReviewStartArgs(restText, { once: subcommand === "once" });
					state = createAutoReviewState(parsed);
					persist(ctx, "started");
					ctx.ui.notify(`Auto-review-loop started${state.once ? " for one iteration" : ""}.`, "info");
					startReviewPrompt(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
				return;
			}

			ctx.ui.notify("Usage: /auto-review start|once|status|pause|resume|stop|clear|answer", "warning");
		},
	});

	pi.registerTool({
		name: "auto_review_result",
		label: "Auto Review Result",
		description: "Report one auto-review slice outcome. The extension starts post-review-loop after safe fixes.",
		promptSnippet: "Finish each auto-review slice by reporting clean, fixed, needs_user, blocked, or no_target.",
		promptGuidelines: [
			"Use this only when the auto-review-loop prompt asks for it.",
			"Auto-fix only tiny obvious local issues with no design or contract decision.",
			"Do not manually start post-review-loop after fixes; this tool lets the extension do it.",
		],
		parameters: ReviewResultSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: ReviewResultParams, _signal, _onUpdate, ctx) {
			if (!state || state.lifecycle !== "active_reviewing") {
				return textToolResult("No active auto-review-loop slice is expecting a result.", { state }, true);
			}
			if (!state.lastSlice) {
				state = updateAutoReviewState(state, { lifecycle: "paused", lastMessage: "Auto-review result arrived without an active review slice." });
				persist(ctx, "result-without-slice");
				return textToolResult(state.lastMessage ?? "No active review slice.", { state }, true, true);
			}

			let resultSummary: AutoReviewResultSummary;
			try {
				resultSummary = {
					status: params.status,
					slice: state.lastSlice,
					summary: params.summary?.trim() || params.blocker?.trim() || "No summary provided.",
					filesReviewed: unique(params.filesReviewed),
					filesChanged: unique(params.filesChanged),
					validation: validation(params.validation),
					findings: findings(params.findings),
					questions: [],
					blocker: params.blocker?.trim() || undefined,
				};
				resultSummary.questions = questions(params.questions, resultSummary.findings, params.blocker);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textToolResult(message, { state }, true);
			}

			if (params.status === "needs_user") {
				const pending = resultSummary.findings.filter((item) => item.tier === "ask_user" || item.userQuestion);
				const qs = resultSummary.questions.length ? resultSummary.questions : ["How should auto-review handle the reported finding(s)?"];
				state = updateAutoReviewState(state, {
					lifecycle: "awaiting_user",
					lastReview: resultSummary,
					pendingFindings: pending,
					awaiting: { kind: "finding_decision", questions: qs, findings: pending },
					lastMessage: "Auto-review needs user input.",
				});
				persist(ctx, "awaiting-user", { result: resultSummary });
				return textToolResult(renderFindingDecisionPrompt(state, pending.length ? pending : resultSummary.findings), { state }, false, true);
			}

			if (params.status === "blocked") {
				state = updateAutoReviewState(state, { lifecycle: "paused", lastReview: resultSummary, awaiting: undefined, lastMessage: resultSummary.blocker ?? resultSummary.summary });
				persist(ctx, "review-blocked", { result: resultSummary });
				return textToolResult(`Auto-review-loop paused: ${state.lastMessage}`, { state }, false, true);
			}

			if (params.status === "no_target") {
				state = updateAutoReviewState(state, { lifecycle: "complete", lastReview: resultSummary, awaiting: undefined, lastMessage: resultSummary.summary });
				persist(ctx, "no-target", { result: resultSummary });
				return textToolResult("Auto-review-loop completed: no review target was available.", { state }, false, true);
			}

			if (params.status === "fixed" || resultSummary.filesChanged.length > 0) {
				state = updateAutoReviewState(state, { lifecycle: "self_reviewing", lastReview: resultSummary, awaiting: undefined, lastMessage: "Auto-review fix completed; post-review-loop starting." });
				persist(ctx, "fix-completed", { result: resultSummary });
				const result = startPostReviewLoop(ctx, resultSummary);
				if (!result.ok) {
					state = updateAutoReviewState(state, { lifecycle: "paused", lastMessage: `Could not start post-review-loop: ${result.reason}` });
					persist(ctx, "post-review-loop-start-failed");
					return textToolResult(state.lastMessage ?? result.reason, { state }, true, true);
				}
				state = updateAutoReviewState(state, { postReviewLoopId: result.state.id, handledPostReviewLoopId: undefined, lastMessage: "Post-review-loop is reviewing the auto-review fix." });
				persist(ctx, "post-review-loop-started", { postReviewLoopId: result.state.id });
				return textToolResult("Auto-review result accepted. Post-review-loop has been started; stop substantial work until its prompts continue.", suppressNotifyDetails({ state }), false, true);
			}

			state = markReviewSliceCompleted(updateAutoReviewState(state, { lastReview: resultSummary, awaiting: undefined, lastMessage: resultSummary.summary }), resultSummary.slice);
			persist(ctx, "review-clean", { result: resultSummary });
			finishOrContinue(ctx, "Review slice finished with no auto-fix or user decision needed.");
			return textToolResult("Auto-review slice recorded as clean.", suppressNotifyDetails({ state }), false, true);
		},
	});

	pi.on("session_start", (event, ctx) => {
		clearScheduledPrompt();
		restore(ctx);
		if (!state || state.lifecycle === "complete") return;
		if (event.reason === "reload" && state.lifecycle === "active_reviewing") {
			state = updateAutoReviewState(state, { lifecycle: "paused", lastMessage: "Paused after reload." });
			persist(ctx, "reload-paused");
			notify(ctx, "Auto-review-loop paused after reload. Use /auto-review resume to continue.", "info");
			return;
		}
		if (state.lifecycle === "active_reviewing" && ctx.isIdle()) startReviewPrompt(ctx);
		if (state.lifecycle === "self_reviewing") handleReviewCompletion(ctx);
		if (state.lifecycle === "awaiting_user") notify(ctx, "Auto-review-loop is waiting for /auto-review answer <decision> or a normal reply.", "info");
	});

	pi.on("agent_end", (_event, ctx) => {
		handleReviewCompletion(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || event.text.trim().startsWith("/")) return { action: "continue" };
		if (!state || state.lifecycle !== "awaiting_user" || !event.text.trim()) return { action: "continue" };

		handleUserDecision(ctx, event.text);
		return { action: "handled" };
	});

	pi.on("session_tree", (_event, ctx) => {
		clearScheduledPrompt();
		restore(ctx);
	});

	pi.on("session_shutdown", () => {
		clearScheduledPrompt();
	});
}
