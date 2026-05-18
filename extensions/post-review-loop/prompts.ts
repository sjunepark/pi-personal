import type { LoopState, Phase } from "./types.js";

function commonHeader(state: LoopState, phase: Phase): string {
	return `Post-review-loop is active.

Scope: ${state.scope}
Phase: ${phase}
Iteration: ${state.iteration}/${state.limit}

Rules:
- Inspect real files and diffs. Do not rely only on summaries.
- Keep Bucket I narrow: concrete, safe, in-scope, worthwhile, and root-cause fixable now.
- Put real issues that need user/product/architecture decisions in Bucket II.
- Reject speculative polish, noisy preferences, and future-proofing.
- Prefer integrated design fixes over wrappers, compatibility layers, and bandages.
- At the end of this phase, call post_review_loop_submit_phase_result with structured facts.
- Do not freehand the final report; the extension renders it.`;
}

function bucketSchemaReminder(): string {
	return `Structured result reminders:
- validation is required. For review-only/planning phases, use result "skipped" with notes explaining no code changed.
- bucketI items need title, revealed, status, fix, files, bandageReason, and validation references.
- bucketII items need title, revealed, weakness, options, recommendedAction, tradeoffs, and status.
- rejectedOrKeptAsIs should explain why a possible finding was rejected or kept.
- codeChanges should be empty unless this phase edited code.`;
}

export function phasePrompt(state: LoopState, phase: Phase = state.phase as Phase): string {
	const header = commonHeader(state, phase);
	if (phase === "post-review") {
		return `${header}

Your task for post-review:
1. Review the current diff and nearby architecture after the previous implementation work.
2. Do not edit code.
3. Produce Bucket I candidates only when they are clearly actionable now.
4. Produce Bucket II recommendations for larger decisions.
5. Submit the phase result with Bucket I candidate statuses as "candidate" or "remaining".

${bucketSchemaReminder()}`;
	}

	if (phase === "impl-review") {
		return `${header}

Your task for impl-review:
1. Re-verify every Bucket I candidate against actual code paths and tests.
2. Do not edit code.
3. Accept only items that are safe, in scope, and have a clear root-cause fix.
4. Reject, downgrade, or move uncertain items to Bucket II.
5. Submit the phase result with accepted items marked "accepted" or "remaining".

${bucketSchemaReminder()}`;
	}

	return `${header}

Your task for impl:
1. Implement only accepted Bucket I fixes.
2. Keep the change tight and integrated.
3. Run focused repository validation using existing commands.
4. Submit applied fixes as Bucket I status "applied" and include codeChanges records.
5. Do not implement Bucket II unless the user explicitly approved it.

${bucketSchemaReminder()}`;
}

export function resumePrompt(state: LoopState): string {
	if (state.phase === "final-report") return "Post-review-loop is ready to render its final report. Call post_review_loop_get_state if needed.";
	return phasePrompt(state, state.phase);
}

export function abortPrompt(reason: string): string {
	return `Post-review-loop stopped: ${reason}\n\nThe extension rendered or can render the deterministic final report from its ledger.`;
}
