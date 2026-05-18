import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { ReviewLoopCompactor } from "./compact.js";
import { establishBaseline } from "./git.js";
import { phasePrompt, resumePrompt } from "./prompts.js";
import { renderFinalReport } from "./report.js";
import { latestStateFromSession, ReviewLoopRuntime } from "./state.js";
import type { LoopState, PhaseResult } from "./types.js";
import { ENTRY_TYPE, STATUS_KEY } from "./types.js";

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean; terminate?: boolean };

const runtime = new ReviewLoopRuntime();
const compactor = new ReviewLoopCompactor();

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
	summary: Type.String({ minLength: 1 }),
	changedFiles: Type.Array(Type.String()),
	validation: Type.Array(ValidationSchema),
	bucketI: Type.Array(BucketISchema),
	bucketII: Type.Array(BucketIISchema),
	rejectedOrKeptAsIs: Type.Array(RejectedSchema),
	codeChanges: Type.Array(CodeChangeSchema),
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

function compactText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function statusText(state: LoopState | null): string {
	if (!state) return "No post-review-loop state.";
	const bucketIActionable = state.bucketI.filter((item) => item.status === "candidate" || item.status === "accepted" || item.status === "remaining").length;
	const failedValidation = state.validation.filter((item) => item.result === "failed").length;
	return [
		`post-review-loop: ${state.lifecycle}`,
		`phase: ${state.phase}`,
		`iteration: ${state.iteration}/${state.limit}`,
		`scope: ${compactText(state.scope)}`,
		`baseline: ${state.baseline.ref} (${state.baseline.mode})`,
		`after-review: ${state.afterReviewCommit.ref} (${state.afterReviewCommit.mode})`,
		`Bucket I actionable/pending total: ${bucketIActionable}/${state.bucketI.length}`,
		`Bucket II: ${state.bucketII.length}`,
		`validation: ${state.validation.length} records, ${failedValidation} failed`,
		compactor.pending ? "checkpoint: pending" : "checkpoint: none",
		state.lastError ? `last error: ${state.lastError}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function statusBar(state: LoopState | null): string | undefined {
	if (!state || state.lifecycle === "complete") return undefined;
	return `pr-loop: ${state.lifecycle} ${state.phase} ${state.iteration}/${state.limit}`;
}

function updateStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusBar(runtime.state));
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, event: string): void {
	pi.appendEntry(ENTRY_TYPE, runtime.entry(event));
	updateStatus(ctx);
}

function parseStartArgs(args: string): { scope: string; limit?: number; reviewOnly: boolean } {
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
	let limit: number | undefined;
	let reviewOnly = false;
	const scopeParts: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--review-only") {
			reviewOnly = true;
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
	return { scope: scopeParts.join(" ").trim(), limit, reviewOnly };
}

function renderReportOnly(): string {
	const state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	return renderFinalReport(state);
}

function completeWithReport(pi: ExtensionAPI, ctx: ExtensionContext, event: string): string {
	const report = renderReportOnly();
	runtime.completeWithReport(report);
	persist(pi, ctx, event);
	return report;
}

function startLoop(pi: ExtensionAPI, ctx: ExtensionContext, scope: string, options: { limit?: number; reviewOnly: boolean }): LoopState {
	const baseline = establishBaseline(ctx.cwd, scope);
	const state = runtime.start(scope, baseline, options);
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
			const options = ["start", "start --limit 3", "start --review-only", "status", "pause", "resume", "stop", "report", "clear"];
			const filtered = options.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcommand = "status", ...rest] = trimmed ? trimmed.split(/\s+/) : ["status"];
			const restText = rest.join(" ");

			if (subcommand === "status") {
				notify(ctx, statusText(runtime.state), "info");
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
				notify(ctx, renderReportOnly(), "info");
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
				notify(ctx, report, "info");
				return;
			}

			if (subcommand === "start") {
				const existing = runtime.state;
				if (existing && existing.lifecycle !== "complete") {
					const ok = await ctx.ui.confirm("Replace active post-review-loop?", statusText(existing));
					if (!ok) return;
				}
				const parsed = parseStartArgs(restText);
				if (!parsed.scope) {
					const input = await ctx.ui.input("Post-review-loop scope", "Describe the files, diff, or implementation to review.");
					parsed.scope = input.trim();
				}
				const state = startLoop(pi, ctx, parsed.scope, { limit: parsed.limit, reviewOnly: parsed.reviewOnly });
				notify(ctx, `Post-review-loop started: ${compactText(state.scope)}`, "info");
				sendPhasePrompt(pi, state);
				return;
			}

			notify(ctx, `Unknown subcommand: ${subcommand}. Use start, status, pause, resume, stop, report, or clear.`, "warning");
		},
	});
}

export default function postReviewLoop(pi: ExtensionAPI): void {
	registerCommand(pi, "post-review-loop");
	registerCommand(pi, "pr-loop");

	pi.registerTool({
		name: "post_review_loop_get_state",
		label: "Get Post Review Loop State",
		description: "Get the active post-review-loop state and next required action.",
		promptSnippet: "Inspect the current post-review-loop phase, iteration, ledger, and required next action.",
		promptGuidelines: ["Use when unsure which post-review-loop phase is active.", "Do not continue a different phase than the state reports."],
		parameters: Type.Object({}),
		async execute() {
			const state = runtime.state;
			return textToolResult(statusText(state), { state, checkpointPending: compactor.pending });
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
					return textToolResult(report, { state: runtime.state, gate }, false, true);
				}

				const queued = compactor.queue(pi, ctx, state);
				persist(pi, ctx, queued ? "checkpoint-queued" : "checkpoint-queue-rejected");
				if (!queued) return textToolResult("A checkpoint is already pending. Stop substantial work and wait for the next phase prompt.", { state, gate }, true, true);
				return textToolResult(
					`Phase result accepted. Gate decision: continue to ${gate.nextPhase}. Checkpoint compaction is queued; stop substantial work for this turn.`,
					{ state, gate, checkpointPending: true },
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
				return textToolResult(report, { state: runtime.state }, false, true);
			} catch (error) {
				return textToolResult(error instanceof Error ? error.message : String(error), { state: runtime.state }, true);
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
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

	pi.on("agent_end", (_event, ctx) => {
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
		compactor.clear(pi);
	});
}
