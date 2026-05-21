import { countCurrentUnresolvedBucketII, currentBucketIItems, currentBucketIIItems, isActionableBucketI, isUnresolvedBucketII } from "./ledger.js";
import type { BucketIItem, BucketIIItem, LoopState, Phase, RejectedItem, ValidationCacheEntry, ValidationResult, WorktreeFingerprint } from "./types.js";

function line(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function promptLine(value: string, maxChars = 220): string {
	const cleaned = line(value);
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars).trimEnd()}… [truncated ${cleaned.length - maxChars} chars]`;
}

function inlineList(values: string[], empty = "none", limit = 5): string {
	const cleaned = values.map((value) => promptLine(value, 160)).filter(Boolean);
	if (!cleaned.length) return empty;
	const shown = cleaned.slice(0, limit).join(", ");
	const remaining = cleaned.length - limit;
	return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function bucketILines(items: BucketIItem[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => `- [${item.status}] ${promptLine(item.title)} — ${promptLine(item.fix, 260)} (${inlineList(item.files)})`)
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
			const suffix = isUnresolvedBucketII(item) ? ` — recommended: ${promptLine(item.recommendedAction, 260)}` : "";
			return `- [${item.status}] ${promptLine(item.title)}${suffix}`;
		})
		.join("\n");
}

function validationLines(records: ValidationResult[]): string {
	if (!records.length) return "- none";
	const failures = records.filter((record) => record.result === "failed");
	const shown = failures.length ? failures.slice(-3) : records.slice(-3);
	return shown.map((record) => `- [${record.result}${record.source === "reused" ? ", reused" : ""}] ${record.phase}: ${promptLine(record.command, 220)} — ${promptLine(record.notes, 260)}`).join("\n");
}

function shortHash(value: string | undefined): string {
	return value ? value.slice(0, 12) : "unknown";
}

function cacheFilesChanged(cache: ValidationCacheEntry, current: WorktreeFingerprint): boolean {
	if (cache.inputKind === "worktree") return cache.worktreeHash !== current.overallHash;
	const fileHashes = cache.fileHashes ?? {};
	return Object.entries(fileHashes).some(([file, hash]) => current.fileHashes[file] !== hash);
}

function reusableValidationEntries(state: LoopState, current?: WorktreeFingerprint): ValidationCacheEntry[] {
	if (!current) return [];
	const byCommand = new Map<string, ValidationCacheEntry>();
	for (const entry of state.validationCache ?? []) {
		if (cacheFilesChanged(entry, current)) continue;
		byCommand.set(entry.command, entry);
	}
	return Array.from(byCommand.values()).slice(-8);
}

function renderReusableValidation(state: LoopState, current?: WorktreeFingerprint): string {
	const entries = reusableValidationEntries(state, current);
	if (!entries.length) return "- none";
	return entries
		.map((entry) => {
			const scope = entry.inputKind === "files" ? inlineList(entry.relevantFiles, "tracked files", 4) : "full worktree fingerprint";
			return `- [${entry.result}] ${promptLine(entry.command, 220)} — input unchanged for ${scope}; previous note: ${promptLine(entry.notes, 260)}`;
		})
		.join("\n");
}

function renderStillCurrentEvidence(state: LoopState, current?: WorktreeFingerprint): string {
	const latest = (state.phaseCaches ?? []).at(-1);
	if (!latest || !current) return "- none";
	const wholeWorktreeUnchanged = latest.fingerprint.overallHash === current.overallHash;
	const unchangedFiles = latest.changedFiles.filter((file) => latest.fingerprint.fileHashes[file] === current.fileHashes[file]);
	if (wholeWorktreeUnchanged) {
		return [
			`- Worktree fingerprint unchanged since iteration ${latest.iteration} ${latest.phase}: ${shortHash(current.overallHash)}.`,
			`- Prior inspection is still current for: ${inlineList(latest.changedFiles, "no recorded files", 8)}.`,
			latest.activeBucketI.length ? `- Active finding context: ${inlineList(latest.activeBucketI.map((item) => `${item.title} [${item.status}]`), "none", 6)}.` : undefined,
		]
			.filter((item): item is string => Boolean(item))
			.join("\n");
	}
	if (unchangedFiles.length) return `- File hashes still match prior inspection for: ${inlineList(unchangedFiles, "none", 8)}. Re-inspect changed files and any new dependencies before relying on older facts.`;
	return "- none; current worktree fingerprint differs from the last cached phase evidence.";
}

function hasUiStateTerms(state: LoopState): boolean {
	const text = [
		state.scope,
		...state.filesChanged,
		...state.baseline.scopedFiles,
		...currentBucketIItems(state.bucketI).flatMap((item) => [item.title, item.fix, ...item.files]),
	]
		.join(" ")
		.toLowerCase();
	return /toolbar|button|disabled|label|readiness|ready|availability|available|action|repair|permission|bridge|settings/.test(text);
}

function stateMatrixChecklist(state: LoopState): string {
	if (!hasUiStateTerms(state)) return "";
	return `\n\nUI/state enablement checklist:\n- For toolbar, button, label, disabled, readiness, availability, permission, bridge, settings, repair, or action findings, review related state combinations together instead of one label/action at a time.\n- Consider dimensions such as external bridge/loading/error/ready, app settings loading/ready/repairable/unavailable, run action run/resume/complete, and in-flight idle/running/restoring.\n- If multiple Bucket I issues share these state domains or files, batch them in one accepted/applied group before checkpointing.`;
}

function reusableEvidenceSection(state: LoopState, current?: WorktreeFingerprint): string {
	return `Still-current evidence cache:\n${renderStillCurrentEvidence(state, current)}\n\nReusable validation cache:\n${renderReusableValidation(state, current)}\n\nUse cached evidence only when the listed hashes are unchanged. You must inspect files changed since that evidence and any new file needed for this phase. If a validation command is reused, submit it with source \"reused\" and note the unchanged input hash; rerun when uncertain.`;
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
	return `Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${promptLine(state.lastGate.reason, 260)}` : "none yet"}
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

function commonHeader(state: LoopState, phase: Phase, currentFingerprint?: WorktreeFingerprint): string {
	return `Post-review-loop active. Follow the reported phase exactly.

Scope: ${promptLine(state.scope, 600)}
Phase: ${phase}
Iteration: ${state.iteration}/${state.limit}
Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${promptLine(state.lastGate.reason, 260)}` : "none yet"}
Checkpoint: ${state.lifecycle}
Current fingerprint: ${currentFingerprint ? shortHash(currentFingerprint.overallHash) : "unavailable; inspect normally"}

Compact ledger:
${renderLedgerSummary(state)}

${reusableEvidenceSection(state, currentFingerprint)}`;
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
- You may cite still-current evidence when the extension-provided fingerprint/file hashes match; re-inspect files changed since that evidence and any new dependencies.
- For default uncommitted-change scope, inspect staged changes, unstaged changes, and untracked files unless a narrower target or unchanged current fingerprint narrows the repeat check.
- Bucket I = concrete, safe, in-scope, root-cause fixable now, and auto-fix-track.
- Bucket II = real decisions needing user/product/architecture judgment; do not implement without explicit approval.
- Reject speculative polish, preferences, broad rewrites, and future-proofing.
- Prefer integrated fixes over wrappers, compatibility layers, or bandages.
- Batch closely related Bucket I work that shares files, modules, or state domains; do not checkpoint after only the first related item when the rest can be safely verified or fixed together.
- Submit only new/materially changed Bucket II items; reuse an existing title verbatim to update it.
- End the phase by calling post_review_loop_submit_phase_result. Do not freehand the final report.${firstPhaseOnly}`;
}

function schemaReminder(): string {
	return `Structured result reminder:
- summary: 1-3 short sentences about the code/behavior reviewed or changed.
- validation: required; use "skipped" with a reason when no code changed; set source "reused" when citing a validation-cache entry with unchanged inputs.
- changedFiles: inspected/reviewed/touched files, not proof of loop edits.
- codeChanges: loop edits only; keep empty in review-only phases.
- Bucket I statuses: "candidate", "accepted", "applied", "rejected", "remaining", "downgraded".
- Bucket II statuses: "left for user decision", "deferred", "kept as-is for now", "implemented after explicit approval".
- commitMessage: optional ordinary project commit message; never mention the loop, checkpointing, automation, or ids.`;
}

export function phasePrompt(state: LoopState, phase: Phase = state.phase as Phase, options: { currentFingerprint?: WorktreeFingerprint } = {}): string {
	const header = commonHeader(state, phase, options.currentFingerprint);
	const amendInstruction = baselineCommitMessageAmendInstruction(state);
	const firstAction = amendInstruction ? `\n\n${amendInstruction}` : "";
	const matrix = stateMatrixChecklist(state);
	if (phase === "post-review") {
		return `${header}${firstAction}

Task: review the current diff and nearby architecture. Do not edit code. Record Bucket I candidates only when likely safe for later automatic implementation; record larger decisions in Bucket II.${matrix}

${coreRules(state)}

${schemaReminder()}`;
	}

	if (phase === "impl-review") {
		return `${header}${firstAction}

Task: re-verify each actionable Bucket I item against actual code paths and tests. Do not edit code. Mark safe, in-scope, root-cause-fixable items as accepted/remaining; reject, downgrade, or move uncertain items to Bucket II. If related candidates share files or state terms, verify them as one batch and accept/reject the batch before checkpointing.${matrix}

${coreRules(state)}

${schemaReminder()}`;
	}

	return `${header}${firstAction}

Task: implement all accepted Bucket I fixes unless a concrete blocker appears. Keep changes tight, integrated, and validated with existing focused commands. Mark fixed items applied and record codeChanges. Do not implement Bucket II without explicit approval. Apply related accepted items in the same files/state boundary before submitting this phase.${matrix}

${coreRules(state)}

${schemaReminder()}`;
}

export function resumePrompt(state: LoopState, options: { currentFingerprint?: WorktreeFingerprint } = {}): string {
	if (state.phase === "final-report") return "Post-review-loop is ready to render its final report. Call post_review_loop_get_state if needed.";
	return phasePrompt(state, state.phase, options);
}

export function renderReusableEvidenceForStatus(state: LoopState, current?: WorktreeFingerprint): string {
	return reusableEvidenceSection(state, current);
}

export function abortPrompt(reason: string): string {
	return `Post-review-loop stopped: ${reason}\n\nThe extension rendered or can render the deterministic final report from its ledger.`;
}
