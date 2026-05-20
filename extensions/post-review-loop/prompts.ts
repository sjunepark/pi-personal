import { countCurrentUnresolvedBucketII, currentBucketIItems, currentBucketIIItems, isActionableBucketI, isUnresolvedBucketII } from "./ledger.js";
import type { BucketIItem, BucketIIItem, LoopState, Phase, RejectedItem, ValidationResult } from "./types.js";

function line(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function inlineList(values: string[], empty = "none", limit = 5): string {
	const cleaned = values.map(line).filter(Boolean);
	if (!cleaned.length) return empty;
	const shown = cleaned.slice(0, limit).join(", ");
	const remaining = cleaned.length - limit;
	return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function bucketILines(items: BucketIItem[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => `- [${item.status}] ${line(item.title)} — ${line(item.fix)} (${inlineList(item.files)})`)
		.join("\n");
}

function appliedBucketILines(items: BucketIItem[]): string {
	const applied = items.filter((item) => item.status === "applied");
	if (!applied.length) return "Applied Bucket I: none";
	return `Applied Bucket I (${applied.length}): ${inlineList(applied.map((item) => item.title), "none", 8)}`;
}

function bucketIILines(items: BucketIIItem[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => {
			const suffix = isUnresolvedBucketII(item) ? ` — recommended: ${line(item.recommendedAction)}` : "";
			return `- [${item.status}] ${line(item.title)}${suffix}`;
		})
		.join("\n");
}

function validationLines(records: ValidationResult[]): string {
	if (!records.length) return "- none";
	const failures = records.filter((record) => record.result === "failed");
	const shown = failures.length ? failures.slice(-3) : records.slice(-3);
	return shown.map((record) => `- [${record.result}] ${record.phase}: ${line(record.command)} — ${line(record.notes)}`).join("\n");
}

function rejectedLines(items: RejectedItem[]): string {
	const byTitle = new Map<string, string>();
	for (const item of items) {
		const title = line(item.title);
		if (title) byTitle.set(title.toLowerCase(), title);
	}
	const titles = Array.from(byTitle.values());
	if (!titles.length) return "Rejected/kept as-is: none";
	return `Rejected/kept as-is (${titles.length}): ${inlineList(titles, "none", 8)}`;
}

export function renderLedgerSummary(state: LoopState): string {
	const currentBucketI = currentBucketIItems(state.bucketI);
	const actionableBucketI = currentBucketI.filter(isActionableBucketI);
	const currentBucketII = currentBucketIIItems(state.bucketII);
	const unresolvedBucketII = countCurrentUnresolvedBucketII(state.bucketII);
	return `Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${line(state.lastGate.reason)}` : "none yet"}
Files in phase scope: ${state.filesChanged.length} total (${inlineList(state.filesChanged)})
Baseline files: ${state.baseline.scopedFiles.length} total (${inlineList(state.baseline.scopedFiles)})

Bucket I actionable (${actionableBucketI.length}; ${currentBucketI.length} current / ${state.bucketI.length} ledger entries):
${bucketILines(actionableBucketI)}
${appliedBucketILines(currentBucketI)}

Bucket II current (${unresolvedBucketII} unresolved / ${currentBucketII.length} current):
${bucketIILines(currentBucketII)}

Recent validation (${state.validation.length} total; failures prioritized):
${validationLines(state.validation)}

${rejectedLines(state.rejectedOrKeptAsIs)}`;
}

function commonHeader(state: LoopState, phase: Phase): string {
	return `Post-review-loop active. Follow the reported phase exactly.

Scope: ${line(state.scope)}
Phase: ${phase}
Iteration: ${state.iteration}/${state.limit}
Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${line(state.lastGate.reason)}` : "none yet"}
Checkpoint: ${state.lifecycle}

Compact ledger:
${renderLedgerSummary(state)}`;
}

function needsBaselineCommitMessageAmend(state: LoopState): boolean {
	return state.baseline.createdCommit && state.baseline.mode === "created-before-review" && state.phasesRun.length === 0;
}

function baselineCommitMessageAmendInstruction(state: LoopState): string {
	if (!needsBaselineCommitMessageAmend(state)) return "";
	return `First, before doing any review work, fix the temporary git checkpoint commit message.
- Inspect the committed changes enough to write a normal project commit message.
- Run git commit --amend so HEAD no longer uses \`checkpoint(post-review-loop): before review\` or mentions checkpointing/post-review-loop automation.
- Use an ordinary subject/body that describes the actual project change, then continue with the phase task.`;
}

function coreRules(state: LoopState): string {
	const firstPhase = state.phasesRun.length === 0;
	const firstPhaseOnly = firstPhase
		? "\n- For the first post-review phase, submit reviewTargetBriefing: one or two approachable paragraphs explaining the review target itself, not loop activity."
		: "";
	return `Rules:
- Inspect real files and diffs before submitting; do not rely only on this prompt.
- For default uncommitted-change scope, inspect staged changes, unstaged changes, and untracked files unless a narrower target was provided.
- Bucket I = concrete, safe, in-scope, root-cause fixable now, and auto-fix-track.
- Bucket II = real decisions needing user/product/architecture judgment; do not implement without explicit approval.
- Reject speculative polish, preferences, broad rewrites, and future-proofing.
- Prefer integrated fixes over wrappers, compatibility layers, or bandages.
- Submit only new/materially changed Bucket II items; reuse an existing title verbatim to update it.
- End the phase by calling post_review_loop_submit_phase_result. Do not freehand the final report.${firstPhaseOnly}`;
}

function schemaReminder(): string {
	return `Structured result reminder:
- summary: 1-3 short sentences about the code/behavior reviewed or changed.
- validation: required; use "skipped" with a reason when no code changed.
- changedFiles: inspected/reviewed/touched files, not proof of loop edits.
- codeChanges: loop edits only; keep empty in review-only phases.
- Bucket I statuses: "candidate", "accepted", "applied", "rejected", "remaining", "downgraded".
- Bucket II statuses: "left for user decision", "deferred", "kept as-is for now", "implemented after explicit approval".
- commitMessage: optional ordinary project commit message; never mention the loop, checkpointing, automation, or ids.`;
}

export function phasePrompt(state: LoopState, phase: Phase = state.phase as Phase): string {
	const header = commonHeader(state, phase);
	const amendInstruction = baselineCommitMessageAmendInstruction(state);
	const firstAction = amendInstruction ? `\n\n${amendInstruction}` : "";
	if (phase === "post-review") {
		return `${header}${firstAction}

Task: review the current diff and nearby architecture. Do not edit code. Record Bucket I candidates only when likely safe for later automatic implementation; record larger decisions in Bucket II.

${coreRules(state)}

${schemaReminder()}`;
	}

	if (phase === "impl-review") {
		return `${header}${firstAction}

Task: re-verify each actionable Bucket I item against actual code paths and tests. Do not edit code. Mark safe, in-scope, root-cause-fixable items as accepted/remaining; reject, downgrade, or move uncertain items to Bucket II.

${coreRules(state)}

${schemaReminder()}`;
	}

	return `${header}${firstAction}

Task: implement all accepted Bucket I fixes unless a concrete blocker appears. Keep changes tight, integrated, and validated with existing focused commands. Mark fixed items applied and record codeChanges. Do not implement Bucket II without explicit approval.

${coreRules(state)}

${schemaReminder()}`;
}

export function resumePrompt(state: LoopState): string {
	if (state.phase === "final-report") return "Post-review-loop is ready to render its final report. Call post_review_loop_get_state if needed.";
	return phasePrompt(state, state.phase);
}

export function abortPrompt(reason: string): string {
	return `Post-review-loop stopped: ${reason}\n\nThe extension rendered or can render the deterministic final report from its ledger.`;
}
