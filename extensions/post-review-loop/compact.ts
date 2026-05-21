import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { computeWorktreeFingerprint } from "./git.js";
import { phasePrompt, renderLedgerSummary } from "./prompts.js";
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
	thinkingLevel: ThinkingLevel;
	started: boolean;
};

const COMPACTION_THINKING_LEVEL: ThinkingLevel = "low";

function clean(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function formatList(items: string[]): string {
	const cleaned = items.map(clean).filter(Boolean);
	return cleaned.length ? cleaned.map((item) => `- ${item}`).join("\n") : "- none";
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
	return `Preserve only the post-review-loop handoff needed to continue after compaction.

Keep:
- loop id ${state.id}
- scope: ${state.scope}
- next phase: ${state.phase}
- iteration: ${state.iteration}/${state.limit}
- last completed phase summary: ${lastPhaseSummary(state)}
- files reviewed / in submitted phase scope
- phase worktree fingerprints and file hashes for reusable inspection evidence
- validation cache entries with command, input hash, and fresh/reused source
- Bucket I findings applied, accepted, remaining, rejected, or downgraded
- Bucket II decision items and recommended actions
- rejected or kept-as-is findings and why
- concise next-step instructions

Drop verbose raw tool output, stale alternatives, repeated reasoning, and implementation details not needed for the next phase.

Files reviewed / in submitted phase scope:
${formatList(state.filesChanged)}

Persisted ledger summary:
${renderLedgerSummary(state)}

Phase evidence cache:
${JSON.stringify((state.phaseCaches ?? []).slice(-3), null, 2)}

Validation cache:
${JSON.stringify((state.validationCache ?? []).slice(-8), null, 2)}

Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${state.lastGate.reason}` : "none"}`;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

export class ReviewLoopCompactor {
	#queued: QueuedCheckpoint | null = null;

	get pending(): boolean {
		return this.#queued !== null;
	}

	queue(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState): boolean {
		if (this.#queued) return false;
		const previousLevel = pi.getThinkingLevel();
		if (previousLevel !== COMPACTION_THINKING_LEVEL) pi.setThinkingLevel(COMPACTION_THINKING_LEVEL);
		this.#queued = { loopId: state.id, state, thinkingLevel: previousLevel, started: false };
		notify(ctx, `Post-review-loop checkpoint queued -> ${state.phase}`, "info");
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
			if (pi.getThinkingLevel() === COMPACTION_THINKING_LEVEL && checkpoint.thinkingLevel !== COMPACTION_THINKING_LEVEL) pi.setThinkingLevel(checkpoint.thinkingLevel);
		};

		const fail = (error: unknown) => {
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

		if (typeof ctx.compact !== "function") {
			fail("ctx.compact is unavailable");
			return;
		}

		notify(ctx, "Post-review-loop checkpoint compaction started", "info");
		try {
			ctx.compact({
				customInstructions: buildCompactionInstructions(checkpoint.state),
				onComplete: () => {
					this.#queued = null;
					restoreThinking();
					const next = runtime.markReady();
					persist("checkpoint-completed");
					notify(ctx, "Post-review-loop checkpoint compaction completed", "info");
					if (next.phase !== "final-report") {
						pi.sendUserMessage(phasePrompt(next, next.phase, { currentFingerprint: computeWorktreeFingerprint(ctx.cwd, fingerprintFiles(next)) }), { deliverAs: "followUp" });
					}
				},
				onError: fail,
			});
		} catch (error) {
			fail(error);
		}
	}

	clear(pi: ExtensionAPI): void {
		const checkpoint = this.#queued;
		if (checkpoint && pi.getThinkingLevel() === COMPACTION_THINKING_LEVEL && checkpoint.thinkingLevel !== COMPACTION_THINKING_LEVEL) {
			pi.setThinkingLevel(checkpoint.thinkingLevel);
		}
		this.#queued = null;
	}
}
