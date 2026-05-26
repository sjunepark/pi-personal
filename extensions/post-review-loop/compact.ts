import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { computeWorktreeFingerprint } from "./git.js";
import { phasePrompt } from "./prompts.js";
import type { LoopState } from "./types.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type PersistFn = (event: string) => void;
type RuntimeOps = {
	markReady(): LoopState;
	markFailed(error: string): LoopState;
};

type QueuedCheckpoint = {
	loopId: string;
	state: LoopState;
	thinkingLevel?: ThinkingLevel;
	started: boolean;
};

const COMPACTION_THINKING_LEVEL: ThinkingLevel = "low";
const COMPACTION_CONTEXT_THRESHOLD_PERCENT = 60;

function clean(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function truncate(value: string, maxChars: number): string {
	const cleaned = clean(value);
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars).trimEnd()}… [truncated ${cleaned.length - maxChars} chars]`;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function fingerprintFiles(state: LoopState): string[] {
	return unique([
		...state.baseline.scopedFiles,
		...state.filesChanged,
		...state.codeChanges.flatMap((item) => item.files),
		...state.bucketI.flatMap((item) => item.files),
	]);
}

function lastPhaseSummary(state: LoopState): string {
	const last = state.phasesRun.at(-1);
	return last ? `Iteration ${last.iteration} ${last.phase}: ${last.summary}` : "No phase has completed yet.";
}

export function buildCompactionInstructions(state: LoopState): string {
	const nextAction =
		state.controlRequest?.action === "stop"
			? "render the final report after compaction"
			: state.controlRequest?.action === "pause"
				? "inject the authoritative next phase prompt after the user resumes the paused loop"
				: "inject the authoritative next phase prompt immediately after compaction";
	return `Create a minimal checkpoint summary for the post-review-loop.

Important token rule: do not copy the post-review-loop ledger, Bucket details, validation rows, file hashes, cache JSON, previous phase prompts, or tool schemas into the compaction summary. The extension persists the canonical ledger outside model context and will ${nextAction}.

Keep only this handoff:
- post-review-loop checkpoint completed
- loop id: ${state.id}
- scope: ${truncate(state.scope, 500)}
- next phase: ${state.phase}
- iteration: ${state.iteration}/${state.limit}
- pending request: ${state.controlRequest ? `${state.controlRequest.action} after iteration ${state.controlRequest.afterIteration}` : "none"}
- last completed phase summary: ${truncate(lastPhaseSummary(state), 500)}
- last gate: ${state.lastGate ? `${state.lastGate.decision}: ${truncate(state.lastGate.reason, 300)}` : "none"}
- if uncertain after compaction, call post_review_loop_get_state and follow the next extension-injected phase prompt

Drop verbose raw tool output, stale alternatives, repeated reasoning, implementation details not needed for the next phase, and all duplicate ledger/cache text.`;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function formatUsage(usage: ReturnType<ExtensionContext["getContextUsage"]>): string {
	if (!usage) return "context usage unavailable";
	const percent = usage.percent === null ? "unknown" : `${usage.percent.toFixed(1)}%`;
	const tokens = usage.tokens === null ? "unknown tokens" : `${usage.tokens.toLocaleString()} tokens`;
	return `${percent} (${tokens} / ${usage.contextWindow.toLocaleString()})`;
}

function shouldCompact(ctx: ExtensionContext): { compact: boolean; reason: string } {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return { compact: false, reason: `${formatUsage(usage)}; below-threshold checkpoint only` };
	if (usage.percent <= COMPACTION_CONTEXT_THRESHOLD_PERCENT) {
		return { compact: false, reason: `${formatUsage(usage)} <= ${COMPACTION_CONTEXT_THRESHOLD_PERCENT}%` };
	}
	return { compact: true, reason: `${formatUsage(usage)} > ${COMPACTION_CONTEXT_THRESHOLD_PERCENT}%` };
}

export class ReviewLoopCompactor {
	#queued: QueuedCheckpoint | null = null;

	get pending(): boolean {
		return this.#queued !== null;
	}

	queue(ctx: ExtensionContext, state: LoopState): boolean {
		if (this.#queued) return false;
		this.#queued = { loopId: state.id, state, started: false };
		notify(ctx, `Post-review-loop checkpoint evaluation queued -> ${state.phase}`, "info");
		return true;
	}

	blockReason(toolName: string): string | undefined {
		if (!this.#queued) return undefined;
		if (toolName === "post_review_loop_submit_phase_result") return "Post-review-loop checkpoint is already pending.";
		return "Post-review-loop checkpoint is pending; finish the turn without more tool calls.";
	}

	runAfterAgent(pi: ExtensionAPI, ctx: ExtensionContext, runtime: RuntimeOps, persist: PersistFn): void {
		const checkpoint = this.#queued;
		if (!checkpoint || checkpoint.started) return;
		checkpoint.started = true;

		const restoreThinking = () => {
			if (checkpoint.thinkingLevel !== undefined && pi.getThinkingLevel() === COMPACTION_THINKING_LEVEL && checkpoint.thinkingLevel !== COMPACTION_THINKING_LEVEL) {
				pi.setThinkingLevel(checkpoint.thinkingLevel);
			}
		};

		const markReady = (event: string, message: string) => {
			if (this.#queued !== checkpoint) return;
			this.#queued = null;
			restoreThinking();
			const next = runtime.markReady();
			persist(event);
			notify(ctx, message, "info");
			if (next.lifecycle === "paused") {
				notify(ctx, "Post-review-loop paused after current iteration. Use /post-review-loop resume to continue.", "info");
				return;
			}
			if (next.phase !== "final-report") {
				pi.sendUserMessage(phasePrompt(next, next.phase, { currentFingerprint: computeWorktreeFingerprint(ctx.cwd, fingerprintFiles(next)) }), { deliverAs: "followUp" });
			}
		};

		const fail = (error: unknown) => {
			if (this.#queued !== checkpoint) return;
			this.#queued = null;
			restoreThinking();
			const message = getErrorMessage(error);
			runtime.markFailed(message);
			persist("checkpoint-failed");
			notify(ctx, `Post-review-loop compaction failed: ${message}`, "error");
			pi.sendUserMessage(`Post-review-loop compaction failed: ${message}\n\nThe loop is paused. Use /post-review-loop resume to continue or /post-review-loop stop to finish.`, {
				deliverAs: "followUp",
			});
		};

		const decision = shouldCompact(ctx);
		if (!decision.compact) {
			markReady("checkpoint-skipped", `Post-review-loop checkpoint compaction skipped: ${decision.reason}`);
			return;
		}

		if (typeof ctx.compact !== "function") {
			fail("ctx.compact is unavailable");
			return;
		}

		checkpoint.thinkingLevel = pi.getThinkingLevel();
		if (checkpoint.thinkingLevel !== COMPACTION_THINKING_LEVEL) pi.setThinkingLevel(COMPACTION_THINKING_LEVEL);

		notify(ctx, `Post-review-loop checkpoint compaction started: ${decision.reason}`, "info");
		try {
			ctx.compact({
				customInstructions: buildCompactionInstructions(checkpoint.state),
				onComplete: () => markReady("checkpoint-completed", "Post-review-loop checkpoint compaction completed"),
				onError: fail,
			});
		} catch (error) {
			fail(error);
		}
	}

	clear(pi: ExtensionAPI): void {
		const checkpoint = this.#queued;
		if (checkpoint?.thinkingLevel !== undefined && pi.getThinkingLevel() === COMPACTION_THINKING_LEVEL && checkpoint.thinkingLevel !== COMPACTION_THINKING_LEVEL) {
			pi.setThinkingLevel(checkpoint.thinkingLevel);
		}
		this.#queued = null;
	}
}
