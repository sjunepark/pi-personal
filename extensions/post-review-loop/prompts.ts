import { countCurrentUnresolvedBucketII, currentBucketIItems, currentBucketIIItems, isActionableBucketI } from "./ledger.js";
import type { BucketIItem, BucketIIItem, LoopState, Phase, RejectedItem, ValidationResult } from "./types.js";

function line(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function inlineList(values: string[], empty = "none"): string {
	const cleaned = values.map(line).filter(Boolean);
	return cleaned.length ? cleaned.join(", ") : empty;
}

function bucketILines(items: BucketIItem[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => {
			const marker = isActionableBucketI(item) ? "actionable" : "recorded";
			return `- [${item.status}; ${marker}] ${line(item.title)} — fix: ${line(item.fix)}; files: ${inlineList(item.files)}`;
		})
		.join("\n");
}

function bucketIILines(items: BucketIIItem[]): string {
	if (!items.length) return "- none";
	return items.map((item) => `- [${item.status}] ${line(item.title)} — recommended: ${line(item.recommendedAction)}`).join("\n");
}

function validationLines(records: ValidationResult[]): string {
	if (!records.length) return "- none";
	return records.slice(-5).map((record) => `- [${record.result}] ${record.phase}: ${line(record.command)} — ${line(record.notes)}`).join("\n");
}

function rejectedLines(items: RejectedItem[]): string {
	if (!items.length) return "- none";
	return items.slice(-5).map((item) => `- ${line(item.title)} — ${line(item.reason)}`).join("\n");
}

export function renderLedgerSummary(state: LoopState): string {
	const currentBucketI = currentBucketIItems(state.bucketI);
	const currentBucketII = currentBucketIIItems(state.bucketII);
	const unresolvedBucketII = countCurrentUnresolvedBucketII(state.bucketII);
	return `Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${line(state.lastGate.reason)}` : "none yet"}
Baseline uncommitted files at loop start: ${inlineList(state.baseline.scopedFiles)}
Files reviewed / in submitted phase scope: ${inlineList(state.filesChanged)}

Bucket I current view (${currentBucketI.length} current / ${state.bucketI.length} ledger entries):
${bucketILines(currentBucketI)}

Bucket II decision items (${unresolvedBucketII} unresolved / ${currentBucketII.length} current):
${bucketIILines(currentBucketII)}

Recent validation:
${validationLines(state.validation)}

Rejected / kept as-is:
${rejectedLines(state.rejectedOrKeptAsIs)}`;
}

function commonHeader(state: LoopState, phase: Phase): string {
	return `Post-review-loop is active.

Scope: ${state.scope}
Phase: ${phase}
Iteration: ${state.iteration}/${state.limit}

Current ledger:
${renderLedgerSummary(state)}

Rules:
- Inspect real files and diffs. Do not rely only on summaries.
- When scope is the default "uncommitted changes", review staged changes, unstaged changes, and untracked files from git status/diff unless the user provided a narrower target.
- Keep Bucket I narrow: concrete, safe, in-scope, worthwhile, and root-cause fixable now.
- Put real issues that need user/product/architecture decisions in Bucket II.
- For Bucket II, submit only new or materially changed decision items. To update an existing item, reuse its title verbatim; do not resubmit unchanged existing items.
- Reject speculative polish, noisy preferences, and future-proofing.
- Prefer integrated design fixes over wrappers, compatibility layers, and bandages.
- Write the phase summary as a short, human-friendly explanation of what code or behavior this phase reviewed/changed; do not use it as a file list or findings list.
- For the first post-review phase, also submit reviewTargetBriefing: one or two kind, teaching-style paragraphs that explain the review target itself. If the target is uncommitted changes, brief the user on what those changes implement or refactor, the main flow, and why the changed area matters. Do not describe the loop phases.
- At the end of this phase, call post_review_loop_submit_phase_result with structured facts.
- Do not freehand the final report; the extension renders it.`;
}

function bucketSchemaReminder(): string {
	return `Structured result reminders:
- summary should be 1-3 short sentences in compact change-explainer style: what this phase reviewed/changed and why that mattered.
- reviewTargetBriefing, when supplied, feeds the final "What Was Reviewed" section. It should explain the review target, not the phase activity: use one or two approachable paragraphs with enough context that the user does not need a separate change-explainer pass.
- validation is required. For review-only/planning phases, use result "skipped" with notes explaining no code changed.
- changedFiles lists files inspected, reviewed, or touched during this phase; it is not evidence that the loop edited those files.
- codeChanges is the authoritative record of loop edits and should be empty unless this phase edited code.
- bucketI items need title, revealed, status, fix, files, bandageReason, and validation references.
- bucketII items need title, revealed, weakness, options, recommendedAction, tradeoffs, and status.
- rejectedOrKeptAsIs should explain why a possible finding was rejected or kept.`;
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
