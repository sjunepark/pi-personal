import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { ReviewLoopCompactor } from "./compact.js";
import { createAfterReviewCommit, establishBaseline, failedAfterReviewCommit } from "./git.js";
import { countCurrentActionableBucketI, countCurrentUnresolvedBucketII, currentBucketIItems, currentBucketIIItems } from "./ledger.js";
import { phasePrompt, renderLedgerSummary, resumePrompt } from "./prompts.js";
import { renderCurrentReport, renderFinalReport, renderReviewSummary } from "./report.js";
import { latestStateFromSession, ReviewLoopRuntime } from "./state.js";
import type { LoopState, PhaseResult } from "./types.js";
import { ENTRY_TYPE, STATUS_KEY } from "./types.js";

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean; terminate?: boolean };
type MarkdownConstructor = new (text: string, paddingX: number, paddingY: number, theme: unknown) => unknown;
type RuntimeDeps = { Markdown: MarkdownConstructor; getMarkdownTheme: () => unknown };
type PendingMarkdownMessage = { title: string; markdown: string };

const runtime = new ReviewLoopRuntime();
const compactor = new ReviewLoopCompactor();
let runtimeDeps: RuntimeDeps | undefined;
const pendingMarkdownMessages: PendingMarkdownMessage[] = [];
let agentActive = false;
const MARKDOWN_MESSAGE_TYPE = "post-review-loop-markdown";
const DEFAULT_REVIEW_SCOPE = "uncommitted changes";

const PhaseSchema = Type.Union([Type.Literal("post-review"), Type.Literal("impl-review"), Type.Literal("impl")]);
const ValidationStatusSchema = Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]);
const BucketIStatusSchema = Type.Union([
	Type.Literal("candidate"),
	Type.Literal("accepted"),
	Type.Literal("applied"),
	Type.Literal("rejected"),
	Type.Literal("remaining"),
	Type.Literal("downgraded"),
]);
const BucketIIStatusSchema = Type.Union([
	Type.Literal("left for user decision"),
	Type.Literal("deferred"),
	Type.Literal("kept as-is for now"),
	Type.Literal("implemented after explicit approval"),
]);

const ValidationSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	result: ValidationStatusSchema,
	phase: Type.Union([PhaseSchema, Type.Literal("final-report")]),
	notes: Type.String({ minLength: 1 }),
});

const BucketISchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	revealed: Type.String({ minLength: 1 }),
	status: BucketIStatusSchema,
	fix: Type.String({ minLength: 1 }),
	files: Type.Array(Type.String()),
	bandageReason: Type.String({ minLength: 1 }),
	validation: Type.Array(Type.String()),
});

const BucketIISchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	revealed: Type.String({ minLength: 1 }),
	weakness: Type.String({ minLength: 1 }),
	options: Type.Array(Type.String()),
	recommendedAction: Type.String({ minLength: 1 }),
	tradeoffs: Type.String({ minLength: 1 }),
	status: BucketIIStatusSchema,
});

const RejectedSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	reason: Type.String({ minLength: 1 }),
});

const CodeChangeSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	files: Type.Array(Type.String()),
	issueAddressed: Type.String({ minLength: 1 }),
	scopeReason: Type.String({ minLength: 1 }),
	validation: Type.Array(Type.String()),
	inspect: Type.String({ minLength: 1 }),
});

const SubmitPhaseResultSchema = Type.Object({
	phase: PhaseSchema,
	iteration: Type.Integer({ minimum: 1 }),
	summary: Type.String({
		minLength: 1,
		description: "Short human-friendly explanation of what was reviewed or changed in this phase; not a file list or bucket list.",
	}),
	reviewTargetBriefing: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"One or two teaching-style paragraphs for the final What Was Reviewed section. Explain the review target itself, such as the uncommitted changes or named feature/refactor, not phase activity.",
		}),
	),
	changedFiles: Type.Array(Type.String(), { description: "Files inspected, reviewed, or touched in this phase; not proof that the loop edited them." }),
	validation: Type.Array(ValidationSchema),
	bucketI: Type.Array(BucketISchema),
	bucketII: Type.Array(BucketIISchema),
	rejectedOrKeptAsIs: Type.Array(RejectedSchema),
	codeChanges: Type.Array(CodeChangeSchema, { description: "Authoritative list of code edits applied by the loop; keep empty for review-only phases." }),
	scopeBlocked: Type.Optional(Type.Boolean()),
	validationBlocked: Type.Optional(Type.Boolean()),
});

const AbortSchema = Type.Object({
	reason: Type.String({ minLength: 1 }),
});

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function textToolResult(text: string, details?: unknown, isError = false, terminate = false): ToolTextResult {
	return { content: [{ type: "text", text }], details, isError, terminate };
}

function loadRuntimeDeps(): RuntimeDeps {
	const runtimeEntry = getRuntimeRequireTarget();
	const requireFromRuntime = createRequire(runtimeEntry);
	const runtimeDir = dirname(runtimeEntry);
	const pi = requireFirst(requireFromRuntime, [join(runtimeDir, "index.js"), join(dirname(runtimeDir), "index.js")]);
	const tui = requireFirst(requireFromRuntime, ["@mariozechner/pi-tui", "@earendil-works/pi-tui"]);
	return { Markdown: tui.Markdown as MarkdownConstructor, getMarkdownTheme: pi.getMarkdownTheme as () => unknown };
}

function requireFirst(requireFromRuntime: (id: string) => any, candidates: string[]): any {
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return requireFromRuntime(candidate);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

function getRuntimeRequireTarget(): string {
	const runtimeEntry = process.argv[1];
	if (runtimeEntry?.includes("/")) {
		try {
			return realpathSync(runtimeEntry);
		} catch {
			return runtimeEntry;
		}
	}
	return fileURLToPath(import.meta.url);
}

function getRuntimeDeps(): RuntimeDeps {
	runtimeDeps ??= loadRuntimeDeps();
	return runtimeDeps;
}

function markdownComponent(markdown: string): any {
	const deps = getRuntimeDeps();
	return new deps.Markdown(markdown, 1, 1, deps.getMarkdownTheme());
}

function sendMarkdownMessage(
	pi: ExtensionAPI,
	title: string,
	markdown: string,
	options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
): void {
	pi.sendMessage(
		{
			customType: MARKDOWN_MESSAGE_TYPE,
			content: title,
			display: true,
			details: { markdown },
		},
		options,
	);
}

function queueMarkdownMessageAfterAgent(title: string, markdown: string): void {
	pendingMarkdownMessages.push({ title, markdown });
}

function showMarkdownMessage(pi: ExtensionAPI, title: string, markdown: string): void {
	if (agentActive) {
		queueMarkdownMessageAfterAgent(title, markdown);
		return;
	}
	sendMarkdownMessage(pi, title, markdown);
}

function flushQueuedMarkdownMessagesAfterAgent(pi: ExtensionAPI): void {
	const messages = pendingMarkdownMessages.splice(0);
	if (!messages.length) return;
	setTimeout(() => {
		for (const message of messages) sendMarkdownMessage(pi, message.title, message.markdown);
	}, 0);
}

function compactText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function statusLines(state: LoopState): string[] {
	const currentBucketI = currentBucketIItems(state.bucketI);
	const currentBucketII = currentBucketIIItems(state.bucketII);
	const bucketIIUnresolved = countCurrentUnresolvedBucketII(state.bucketII);
	const bucketIActionable = countCurrentActionableBucketI(state.bucketI);
	const failedValidation = state.validation.filter((item) => item.result === "failed").length;
	return [
		`post-review-loop: ${state.lifecycle}`,
		`phase: ${state.phase}`,
		`iteration: ${state.iteration}/${state.limit}`,
		`scope: ${compactText(state.scope)}`,
		`baseline: ${state.baseline.ref} (${state.baseline.mode})`,
		`after-review: ${state.afterReviewCommit.ref} (${state.afterReviewCommit.mode})`,
		`Bucket I current actionable/pending: ${bucketIActionable}/${currentBucketI.length} (${state.bucketI.length} ledger entries)`,
		`Bucket II unresolved/current: ${bucketIIUnresolved}/${currentBucketII.length}`,
		`validation: ${state.validation.length} records, ${failedValidation} failed`,
		compactor.pending ? "checkpoint: pending" : "checkpoint: none",
		state.lastError ? `last error: ${state.lastError}` : undefined,
	].filter((line): line is string => Boolean(line));
}

function statusText(state: LoopState | null): string {
	if (!state) return "No post-review-loop state.";
	return `${statusLines(state).join("\n")}\n\nWhat was reviewed:\n${renderReviewSummary(state)}\n\nLedger:\n${renderLedgerSummary(state)}`;
}

function statusMarkdown(state: LoopState | null): string {
	if (!state) return "No post-review-loop state.";
	return [
		"# Post-Review Loop Status",
		"",
		...statusLines(state).map((line) => `- ${line}`),
		"",
		"## What Was Reviewed",
		"",
		renderReviewSummary(state),
		"",
		"## Ledger",
		"",
		renderLedgerSummary(state),
	].join("\n");
}

function statusBar(state: LoopState | null): string | undefined {
	if (!state || state.lifecycle === "complete") return undefined;
	return `post-review-loop: ${state.lifecycle} ${state.phase} ${state.iteration}/${state.limit}`;
}

function updateStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusBar(runtime.state));
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, event: string): void {
	pi.appendEntry(ENTRY_TYPE, runtime.entry(event));
	updateStatus(ctx);
}

function parseStartArgs(args: string): { scope: string; limit?: number; reviewOnly: boolean; gitCheckpoint: boolean } {
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
	let limit: number | undefined;
	let reviewOnly = false;
	let gitCheckpoint = true;
	const scopeParts: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--review-only") {
			reviewOnly = true;
			continue;
		}
		if (token === "--no-git-checkpoint") {
			gitCheckpoint = false;
			continue;
		}
		if (token === "--git-checkpoint") {
			gitCheckpoint = true;
			continue;
		}
		if (token === "--limit") {
			const raw = tokens[index + 1];
			if (!raw) throw new Error("--limit requires a number");
			limit = Number.parseInt(raw, 10);
			index += 1;
			continue;
		}
		if (token.startsWith("--limit=")) {
			limit = Number.parseInt(token.slice("--limit=".length), 10);
			continue;
		}
		scopeParts.push(token);
	}
	return { scope: scopeParts.join(" ").trim(), limit, reviewOnly, gitCheckpoint };
}

function renderReportOnly(): string {
	const state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	return state.lifecycle === "complete" || state.phase === "final-report" ? renderFinalReport(state) : renderCurrentReport(state);
}

function registerMarkdownRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(MARKDOWN_MESSAGE_TYPE, (message) => {
		const details = message.details as { markdown?: string } | undefined;
		const fallback = typeof message.content === "string" ? message.content : "";
		return markdownComponent(details?.markdown ?? fallback);
	});
}

function completeWithReport(pi: ExtensionAPI, ctx: ExtensionContext, event: string): string {
	let state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	try {
		runtime.recordAfterReviewCommit(createAfterReviewCommit(ctx.cwd, state));
	} catch (error) {
		runtime.recordAfterReviewCommit(failedAfterReviewCommit(ctx.cwd, state, error), error instanceof Error ? error.message : String(error));
	}
	state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	const report = renderFinalReport(state);
	runtime.completeWithReport(report);
	persist(pi, ctx, event);
	return report;
}

function startLoop(pi: ExtensionAPI, ctx: ExtensionContext, scope: string, options: { limit?: number; reviewOnly: boolean; gitCheckpoint: boolean }): LoopState {
	const baseline = establishBaseline(ctx.cwd, scope, { checkpoint: options.gitCheckpoint });
	const state = runtime.start(baseline.reviewScope ?? scope, baseline, options);
	persist(pi, ctx, "started");
	return state;
}

function sendPhasePrompt(pi: ExtensionAPI, state: LoopState): void {
	if (state.phase === "final-report") return;
	pi.sendUserMessage(phasePrompt(state, state.phase), { deliverAs: "followUp" });
}

function registerCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: "Run the deterministic post-review-loop workflow",
		getArgumentCompletions(prefix) {
			const options = ["start", "start --limit 3", "start --review-only", "start --no-git-checkpoint", "status", "pause", "resume", "stop", "report", "clear"];
			const filtered = options.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcommand = "status", ...rest] = trimmed ? trimmed.split(/\s+/) : ["status"];
			const restText = rest.join(" ");

			if (subcommand === "status") {
				showMarkdownMessage(pi, "Post-review-loop status", statusMarkdown(runtime.state));
				return;
			}

			if (subcommand === "clear") {
				compactor.clear(pi);
				const previous = runtime.clear();
				persist(pi, ctx, "cleared");
				notify(ctx, previous ? "Post-review-loop state cleared." : "No post-review-loop state to clear.", "info");
				return;
			}

			if (subcommand === "pause") {
				const state = runtime.pause();
				if (!state) {
					notify(ctx, "No active post-review-loop to pause.", "warning");
					return;
				}
				persist(pi, ctx, "paused");
				notify(ctx, "Post-review-loop paused.", "info");
				return;
			}

			if (subcommand === "resume") {
				const state = runtime.resume();
				if (!state) {
					notify(ctx, "No paused post-review-loop to resume.", "warning");
					return;
				}
				persist(pi, ctx, "resumed");
				notify(ctx, "Post-review-loop resumed.", "info");
				pi.sendUserMessage(resumePrompt(state), { deliverAs: "followUp" });
				return;
			}

			if (subcommand === "report") {
				showMarkdownMessage(pi, "Post-review-loop report", renderReportOnly());
				return;
			}

			if (subcommand === "stop") {
				const state = runtime.state;
				if (!state) {
					notify(ctx, "No post-review-loop state to stop.", "warning");
					return;
				}
				if (state.lifecycle !== "complete") runtime.abort("user stopped the loop");
				const report = completeWithReport(pi, ctx, "stopped");
				showMarkdownMessage(pi, "Post-review-loop final report", report);
				return;
			}

			if (subcommand === "start") {
				const existing = runtime.state;
				if (existing && existing.lifecycle !== "complete") {
					const ok = await ctx.ui.confirm("Replace active post-review-loop?", statusText(existing));
					if (!ok) return;
				}
				const parsed = parseStartArgs(restText);
				const scope = parsed.scope || DEFAULT_REVIEW_SCOPE;
				const state = startLoop(pi, ctx, scope, { limit: parsed.limit, reviewOnly: parsed.reviewOnly, gitCheckpoint: parsed.gitCheckpoint });
				notify(ctx, `Post-review-loop started: ${compactText(state.scope)}`, "info");
				sendPhasePrompt(pi, state);
				return;
			}

			notify(ctx, `Unknown subcommand: ${subcommand}. Use start, status, pause, resume, stop, report, or clear.`, "warning");
		},
	});
}

export default function postReviewLoop(pi: ExtensionAPI): void {
	registerMarkdownRenderer(pi);
	registerCommand(pi, "post-review-loop");

	pi.registerTool({
		name: "post_review_loop_get_state",
		label: "Get Post Review Loop State",
		description: "Get the active post-review-loop state and next required action.",
		promptSnippet: "Inspect the current post-review-loop phase, iteration, ledger, and required next action.",
		promptGuidelines: ["Use when unsure which post-review-loop phase is active.", "Do not continue a different phase than the state reports."],
		parameters: Type.Object({}),
		async execute() {
			const state = runtime.state;
			return textToolResult(statusMarkdown(state), { state, checkpointPending: compactor.pending });
		},
		renderResult(result) {
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			return markdownComponent(text);
		},
	});

	pi.registerTool({
		name: "post_review_loop_submit_phase_result",
		label: "Submit Post Review Loop Phase Result",
		description: "Submit structured facts for the completed post-review-loop phase. The extension decides stop vs continue.",
		promptSnippet: "Submit the completed phase result after real inspection, edits, and validation for the current post-review-loop phase.",
		promptGuidelines: [
			"Call only at the end of the active post-review-loop phase.",
			"The extension, not the model, decides whether to continue or stop.",
			"Treat accepted Bucket I as auto-fix-track work: impl phases should apply it unless a concrete blocker exists; candidates are not fixed during review-only phases.",
			"Only submit new or materially changed Bucket II items; reuse the existing title verbatim for updates and omit unchanged existing Bucket II items.",
			"After a continue result, stop substantial work until the next phase prompt arrives.",
		],
		parameters: SubmitPhaseResultSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: PhaseResult, _signal, _onUpdate, ctx) {
			try {
				const { state, gate } = runtime.submit(params);
				persist(pi, ctx, "phase-submitted");
				if (gate.decision === "stop") {
					const report = completeWithReport(pi, ctx, "final-report-rendered");
					queueMarkdownMessageAfterAgent("Post-review-loop final report", report);
					return textToolResult("Post-review-loop stopped. The final report will render as a separate markdown message.", { state: runtime.state, gate }, false, true);
				}

				const queued = compactor.queue(pi, ctx, state);
				persist(pi, ctx, queued ? "checkpoint-queued" : "checkpoint-queue-rejected");
				if (!queued) return textToolResult("A checkpoint is already pending. Stop substantial work and wait for the next phase prompt.", { state, gate }, true, true);
				return textToolResult(
					`Phase result accepted. Gate decision: continue to ${gate.nextPhase}. Checkpoint compaction is queued; stop substantial work for this turn.`,
					{
						state,
						gate,
						checkpointPending: true,
						notify: {
							suppressCompletion: true,
							status: "Continuing",
							logMessage: "Post-review-loop phase accepted; checkpoint compaction is queued",
						},
					},
					false,
					true,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textToolResult(message, { state: runtime.state }, true, false);
			}
		},
	});

	pi.registerTool({
		name: "post_review_loop_abort",
		label: "Abort Post Review Loop",
		description: "Stop the active post-review-loop with a structured reason when scope, context, approval, or validation blocks safe continuation.",
		parameters: AbortSchema,
		async execute(_toolCallId, params: { reason: string }, _signal, _onUpdate, ctx) {
			try {
				runtime.abort(params.reason);
				const report = completeWithReport(pi, ctx, "aborted");
				queueMarkdownMessageAfterAgent("Post-review-loop final report", report);
				return textToolResult("Post-review-loop aborted. The final report will render as a separate markdown message.", { state: runtime.state }, false, true);
			} catch (error) {
				return textToolResult(error instanceof Error ? error.message : String(error), { state: runtime.state }, true);
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		agentActive = false;
		pendingMarkdownMessages.splice(0);
		compactor.clear(pi);
		runtime.restore(latestStateFromSession(ctx));
		const state = runtime.state;
		if (state?.lifecycle === "checkpointing") {
			runtime.markCheckpointFailed("Session restored while checkpointing; checkpoint was not completed.");
			persist(pi, ctx, "checkpoint-restored-paused");
			notify(ctx, "Post-review-loop restored from checkpointing state and paused. Use /post-review-loop resume.", "warning");
			return;
		}
		if (state?.lifecycle === "active" && event.reason === "reload") {
			runtime.pause();
			persist(pi, ctx, "reload-paused");
			notify(ctx, "Post-review-loop paused after reload. Use /post-review-loop resume.", "info");
			return;
		}
		updateStatus(ctx);
		if (state && state.lifecycle !== "complete") notify(ctx, `Post-review-loop restored: ${state.lifecycle} ${state.phase} ${state.iteration}/${state.limit}`, "info");
	});

	pi.on("session_tree", (_event, ctx) => {
		compactor.clear(pi);
		runtime.restore(latestStateFromSession(ctx));
		updateStatus(ctx);
	});

	pi.on("tool_call", (event) => {
		const reason = compactor.blockReason(event.toolName);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("agent_start", () => {
		agentActive = true;
	});

	pi.on("agent_end", (_event, ctx) => {
		agentActive = false;
		flushQueuedMarkdownMessagesAfterAgent(pi);
		compactor.runAfterAgent(
			pi,
			ctx,
			{
				markReady: () => runtime.markCheckpointReady(),
				markFailed: (error) => runtime.markCheckpointFailed(error),
			},
			(event) => persist(pi, ctx, event),
		);
	});

	pi.on("session_shutdown", () => {
		agentActive = false;
		pendingMarkdownMessages.splice(0);
		compactor.clear(pi);
	});
}
