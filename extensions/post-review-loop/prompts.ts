import { countCurrentUnresolvedBucketII, currentBucketIItems, currentBucketIIItems, isActionableBucketI, isUnresolvedBucketII } from "./ledger.js";
import { DESIGN_SIGNALS } from "./types.js";
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

function designSignalLine(item: { designSignal?: string }): string {
	return item.designSignal ? `; signal: ${promptLine(item.designSignal, 120)}` : "";
}

function designSignalOptions(separator: string): string {
	return DESIGN_SIGNALS.map((signal) => `"${signal}"`).join(separator);
}

function bucketILines(items: BucketIItem[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => `- [${item.status}] ${promptLine(item.title)} — ${promptLine(item.fix, 260)}${designSignalLine(item)} (${inlineList(item.files)})`)
		.join("\n");
}

function appliedBucketILines(items: BucketIItem[]): string | undefined {
	const applied = items.filter((item) => item.status === "applied");
	if (!applied.length) return undefined;
	return `Applied Bucket I (${applied.length}): ${inlineList(applied.map((item) => item.title), "none", 8)}`;
}

function bucketIILines(items: BucketIIItem[]): string {
	if (!items.length) return "- none";
	return items
		.map((item) => {
			const suffix = isUnresolvedBucketII(item) ? ` — recommended: ${promptLine(item.recommendedAction, 260)}` : "";
			return `- [${item.status}] ${promptLine(item.title)}${designSignalLine(item)}${suffix}`;
		})
		.join("\n");
}

function validationLines(records: ValidationResult[]): string {
	if (!records.length) return "- none";
	const failures = records.filter((record) => record.result === "failed");
	const shown = failures.length ? failures.slice(-3) : records.slice(-3);
	return shown.map((record) => `- [${record.result}${record.source === "reused" ? ", reused" : ""}] ${record.phase}: ${promptLine(record.command, 220)} — ${promptLine(record.notes, 260)}`).join("\n");
}

const BUCKET_I_PROMPT_BATCH_LIMIT = 8;
const BUCKET_II_PROMPT_BATCH_LIMIT = 6;

type BucketIBatch = {
	active: BucketIItem[];
	relevant: BucketIItem[];
	shown: BucketIItem[];
};

function bucketIRelevantToPhase(items: BucketIItem[], phase: Phase): BucketIItem[] {
	if (phase === "impl") return items.filter((item) => item.status === "accepted" || item.status === "remaining");
	if (phase === "impl-review") return items.filter((item) => item.status === "candidate" || item.status === "remaining");
	return items;
}

function bucketIBatchForPhase(items: BucketIItem[], phase: Phase): BucketIBatch {
	const active = items.filter(isActionableBucketI);
	const relevant = bucketIRelevantToPhase(active, phase);
	return { active, relevant, shown: relevant.slice(0, BUCKET_I_PROMPT_BATCH_LIMIT) };
}

function bucketIBatchOverflowLine(batch: BucketIBatch): string | undefined {
	const hiddenRelevant = batch.relevant.length - batch.shown.length;
	const hiddenOtherActive = batch.active.length - batch.relevant.length;
	const parts = [hiddenRelevant > 0 ? `${hiddenRelevant} more relevant Bucket I item(s) remain queued outside this prompt batch` : undefined, hiddenOtherActive > 0 ? `${hiddenOtherActive} other active Bucket I item(s) remain queued for a later phase` : undefined].filter(Boolean);
	return parts.length ? `- ${parts.join("; ")}. Do not mark hidden items resolved unless this phase inspected or changed them.` : undefined;
}

function bucketIStatusSummary(batch: BucketIBatch, phase: Phase, ledgerCount: number): string {
	return `Bucket I actionable (${batch.active.length} active / ${ledgerCount} ledger entries; ${batch.relevant.length} relevant to ${phase}; showing ${batch.shown.length}):`;
}

function bucketIIBatchLines(items: BucketIIItem[]): string {
	const shown = items.slice(0, BUCKET_II_PROMPT_BATCH_LIMIT);
	const overflow = items.length - shown.length;
	return [bucketIILines(shown), overflow > 0 ? `- ${overflow} more Bucket II item(s) remain queued outside this compact prompt. Use full status/report before deciding on hidden items.` : undefined]
		.filter((part): part is string => Boolean(part))
		.join("\n");
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
	if (!latest || !current) return "";
	const wholeWorktreeUnchanged = latest.fingerprint.overallHash === current.overallHash;
	const unchangedFiles = latest.changedFiles.filter((file) => latest.fingerprint.fileHashes[file] === current.fileHashes[file]);
	if (wholeWorktreeUnchanged) {
		return [
			`- Inspection still current for iteration ${latest.iteration} ${latest.phase}: ${inlineList(latest.changedFiles, "no recorded files", 8)} (${shortHash(current.overallHash)}).`,
			latest.activeBucketI.length ? `- Active finding context: ${inlineList(latest.activeBucketI.map((item) => `${item.title} [${item.status}]`), "none", 6)}.` : undefined,
		]
			.filter((item): item is string => Boolean(item))
			.join("\n");
	}
	if (unchangedFiles.length) return `- File hashes still match prior inspection for: ${inlineList(unchangedFiles, "none", 8)}; re-inspect changed files and new dependencies.`;
	return "";
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
	return `\n\nUI/state enablement checklist:\n- For toolbar, button, label, disabled, readiness, availability, permission, bridge, settings, repair, or action findings, review related state combinations together instead of one label/action at a time.\n- Consider dimensions such as external bridge/loading/error/ready, app settings loading/ready/repairable/unavailable, run action run/resume/complete, and in-flight idle/running/restoring.\n- If multiple Bucket I issues share these state domains or files, batch them in one accepted/applied group before ending the phase.`;
}

function reusableEvidenceSection(state: LoopState, current?: WorktreeFingerprint): string {
	const evidence = renderStillCurrentEvidence(state, current);
	const validation = renderReusableValidation(state, current);
	const sections = [
		evidence ? `Still-current evidence:\n${evidence}` : undefined,
		validation !== "- none" ? `Reusable validation:\n${validation}` : undefined,
	].filter((section): section is string => Boolean(section));
	if (!sections.length) return "Reusable evidence: none; inspect normally.";
	return `${sections.join("\n\n")}\n\nReuse only the listed unchanged evidence; re-inspect changed files or uncertain validation inputs.`;
}

function rejectedLines(items: RejectedItem[]): string | undefined {
	const byTitle = new Map<string, string>();
	for (const item of items) {
		const title = line(item.title);
		if (title) byTitle.set(title.toLowerCase(), title);
	}
	const titles = Array.from(byTitle.values());
	if (!titles.length) return undefined;
	return `Rejected/kept as-is (${titles.length}): ${inlineList(titles, "none", 8)}`;
}

export function renderLedgerSummary(state: LoopState, phase: Phase = state.phase as Phase): string {
	const currentBucketI = currentBucketIItems(state.bucketI);
	const bucketIBatch = bucketIBatchForPhase(currentBucketI, phase);
	const currentBucketII = currentBucketIIItems(state.bucketII);
	const unresolvedBucketII = countCurrentUnresolvedBucketII(state.bucketII);
	const showBaselineFiles = state.phasesRun.length === 0 && state.baseline.scopedFiles.length > 0;
	const hasBucketII = currentBucketII.length > 0;
	const rejected = rejectedLines(state.rejectedOrKeptAsIs);
	const lines = [
		`Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${promptLine(state.lastGate.reason, 260)}` : "none yet"}`,
		state.filesChanged.length ? `Phase-scope files so far: ${state.filesChanged.length} (${inlineList(state.filesChanged)})` : undefined,
		showBaselineFiles ? `Baseline files: ${state.baseline.scopedFiles.length} (${inlineList(state.baseline.scopedFiles)})` : undefined,
		"",
		bucketIStatusSummary(bucketIBatch, phase, state.bucketI.length),
		bucketILines(bucketIBatch.shown),
		bucketIBatchOverflowLine(bucketIBatch),
		appliedBucketILines(currentBucketI),
		hasBucketII ? "" : undefined,
		hasBucketII ? `Bucket II current (${unresolvedBucketII} unresolved / ${currentBucketII.length} current; showing ${Math.min(currentBucketII.length, BUCKET_II_PROMPT_BATCH_LIMIT)}):` : undefined,
		hasBucketII ? bucketIIBatchLines(currentBucketII) : undefined,
		state.validation.length ? "" : undefined,
		state.validation.length ? `Recent validation (${state.validation.length} total; failures prioritized):` : undefined,
		state.validation.length ? validationLines(state.validation) : undefined,
		rejected ? "" : undefined,
		rejected,
	];
	return lines.filter((item): item is string => item !== undefined).join("\n");
}

function commonHeader(state: LoopState, phase: Phase, currentFingerprint?: WorktreeFingerprint): string {
	return `Post-review-loop active. Follow the reported phase exactly.

Scope: ${promptLine(state.scope, 600)}
Phase: ${phase}
Iteration: ${state.iteration}/${state.limit}
Lifecycle: ${state.lifecycle}
Current fingerprint: ${currentFingerprint ? shortHash(currentFingerprint.overallHash) : "unavailable; inspect normally"}

Compact ledger:
${renderLedgerSummary(state, phase)}

${reusableEvidenceSection(state, currentFingerprint)}`;
}

function needsLegacyBaselineCommitMessageAmend(state: LoopState): boolean {
	return state.baseline.createdCommit && state.baseline.mode === "created-before-review" && state.phasesRun.length === 0;
}

function legacyBaselineCommitMessageAmendInstruction(state: LoopState): string {
	if (!needsLegacyBaselineCommitMessageAmend(state)) return "";
	return `First, before doing any review work, fix the temporary git checkpoint commit message.
- Inspect the committed changes enough to write a normal project commit message.
- Run git commit --amend so HEAD no longer uses \`checkpoint(post-review-loop): before review\` or mentions checkpointing/post-review-loop automation.
- Use an ordinary subject/body that describes the actual project change, then continue with the phase task.`;
}

function needsSelectiveBaselineCheckpoint(state: LoopState): boolean {
	return state.baseline.mode === "agent-selected-before-review" && state.phasesRun.length === 0 && state.baseline.scopedFiles.length > 0;
}

function selectiveBaselineCheckpointInstruction(state: LoopState): string {
	if (!needsSelectiveBaselineCheckpoint(state)) return "";
	const originalRef = state.baseline.originalRef ?? state.baseline.ref;
	return `First, before doing any review work, create a selective git checkpoint for the requested review target.
- Inspect git status, staged changes, unstaged changes, untracked files, and the requested scope.
- Commit only the uncommitted changes that are relevant to this review target. You may stage partial hunks when a file mixes relevant and unrelated work.
- Leave unrelated files or hunks uncommitted; do not discard or rewrite unrelated work.
- Use your best judgment without asking the user when relevance is ambiguous. Report what you intentionally left out in the phase summary or rejected/kept-as-is notes when useful.
- Write a normal project commit message that describes the selected change. Do not mention checkpointing, the loop, or automation.
- If no uncommitted changes clearly belong to the review target, do not commit; continue the review against the requested scope.
- If you do commit selected changes, treat ${originalRef}..HEAD as the primary reviewed implementation boundary for this first pass, plus any explicitly relevant uncommitted leftovers.`;
}

function coreRules(state: LoopState): string {
	const firstPhase = state.phasesRun.length === 0;
	if (!firstPhase) {
		return `Rules:
- Inspect real files/diffs needed for this phase; reuse cached facts only when the listed hashes still match.
- Bucket I is auto-fix-track; Bucket II needs explicit approval. Classify each finding with an allowed designSignal.
- Prefer strong, root-cause findings and integrated fixes; reject speculative polish, wrappers, and broad future-proofing.
- Batch related Bucket I work that shares files, modules, or state domains; hidden prompt-batch items remain active unless you inspect full status/report.
- Submit only new/materially changed Bucket II items; reuse existing titles for updates.
- If delegating review to a subagent, do not downshift to a mini/cheap model for correctness or design review; use the active high-reasoning review model, or the user's explicitly requested review model/thinking such as gpt-5.5 with high thinking.
- Keep delegated reviewer context fresh but not context-starved: pass the scope, phase, relevant prior findings/concerns, expected output shape, and validation expectations, then have the reviewer inspect real files/diffs itself.
- End by calling post_review_loop_submit_phase_result; do not freehand the final report.`;
	}
	return `Rules:
- Inspect real files and diffs before submitting; do not rely only on this prompt.
- You may cite still-current evidence when the extension-provided fingerprint/file hashes match; re-inspect files changed since that evidence and any new dependencies.
- For default uncommitted-change scope, inspect staged changes, unstaged changes, and untracked files unless a narrower target or unchanged current fingerprint narrows the repeat check. If you created a selective first-pass checkpoint commit, review the original HEAD..current HEAD commit range as the primary target and inspect remaining dirty work only for relevance.
- Bucket I = concrete, safe, in-scope, root-cause fixable now, and auto-fix-track.
- Bucket II = real decisions needing user/product/architecture judgment; do not implement without explicit approval.
- For every Bucket I/Bucket II item, name the visible symptom, expected behavior, and root cause briefly in the finding fields, then classify designSignal as the best fit from the schema.
- Treat designSignal as an evidence filter: prefer findings that expose ownership, invariant, type/schema, lifecycle, abstraction, or integration weakness over isolated polish.
- Prefer the strongest practical findings over exhaustive lists; if several related findings share the same root cause, batch them instead of submitting duplicates.
- Reject speculative polish, preferences, broad rewrites, and future-proofing.
- Prefer integrated fixes over wrappers, compatibility layers, or bandages.
- When a Bucket I fix suggests a plausible broader refactor/redesign would better address the underlying shape, still apply the safe Bucket I fix when appropriate, but also submit a Bucket II item explaining the broader option, tradeoffs, and why it needs explicit approval before implementation.
- Do not invent refactor alternatives for every fix. Record the broader-refactor Bucket II only when actual inspected code shows meaningful ownership, boundary, abstraction, lifecycle, schema/type, or integration implications beyond the safe fix.
- Batch closely related Bucket I work that shares files, modules, or state domains; do not stop after only the first related item when the rest can be safely verified or fixed together.
- If the compact ledger says active items are queued outside this prompt batch, work only on the shown relevant batch unless you explicitly inspect full status/report; hidden items remain active in the persisted ledger and must not be marked resolved by omission.
- Submit only new/materially changed Bucket II items; reuse an existing title verbatim to update it.
- If delegating review to a subagent, do not downshift to a mini/cheap model for correctness or design review; use the active high-reasoning review model, or the user's explicitly requested review model/thinking such as gpt-5.5 with high thinking.
- Keep delegated reviewer context fresh but not context-starved: pass the scope, phase, relevant prior findings/concerns, expected output shape, and validation expectations, then have the reviewer inspect real files/diffs itself.
- For the first post-review phase, submit reviewTargetBriefing: one or two approachable paragraphs explaining the review target itself, not loop activity.
- End the phase by calling post_review_loop_submit_phase_result. Do not freehand the final report.`;
}

function codeChangeLines(state: LoopState): string {
	if (!state.codeChanges.length) return "- none";
	return state.codeChanges.map((item) => `- ${promptLine(item.title)} (${inlineList(item.files, "no files", 8)}): ${promptLine(item.issueAddressed, 260)}`).join("\n");
}

function finalCommitMessageLines(state: LoopState): string {
	if (!state.commitMessage?.subject.trim()) return "No commit message was submitted; write a normal project commit message from the actual selected changes.";
	return [`Suggested subject: ${state.commitMessage.subject.trim()}`, state.commitMessage.body?.trim() ? `Suggested body:\n${state.commitMessage.body.trim()}` : undefined]
		.filter((item): item is string => Boolean(item))
		.join("\n");
}

export function finalCommitPrompt(state: LoopState): string {
	return `Post-review-loop reached its final gate. Before the final report, create the after-review commit with agent-selected staging.

Scope: ${promptLine(state.scope, 600)}
Original baseline: ${state.baseline.originalRef ?? state.baseline.ref}
Reviewed/edited files: ${inlineList([...state.filesChanged, ...state.codeChanges.flatMap((item) => item.files)], "none", 12)}

Loop-applied code changes:
${codeChangeLines(state)}

Commit message guidance:
${finalCommitMessageLines(state)}

Task:
- Inspect git status, staged changes, unstaged changes, and the loop-applied codeChanges above.
- Stage and commit only the changes that were applied by this review loop. You may use partial hunk staging when a file mixes loop edits with unrelated work.
- Leave unrelated files or hunks uncommitted; do not discard or rewrite unrelated work.
- If the relevant loop edits are already committed, do not create a duplicate commit; report the existing HEAD/ref.
- If no loop-applied edits remain to commit, do not commit.
- Use a normal project commit message. Do not mention checkpointing, the loop, automation, or internal ids.
- After the commit decision, call post_review_loop_submit_final_commit_result. Do not call post_review_loop_submit_phase_result again.`;
}

function schemaReminder(state: LoopState): string {
	if (state.phasesRun.length > 0) {
		return `Structured result reminder: submit summary, changedFiles, validation, Bucket I/Bucket II with exact statuses/designSignal, rejectedOrKeptAsIs, codeChanges for loop edits only, and an ordinary commitMessage when useful.`;
	}
	return `Structured result reminder:
- summary: 1-3 short sentences about the code/behavior reviewed or changed.
- validation: required; use "skipped" with a reason when no code changed; set source "reused" when citing a validation-cache entry with unchanged inputs.
- changedFiles: inspected/reviewed/touched files, not proof of loop edits.
- codeChanges: loop edits only; keep empty in review-only phases.
- Bucket I statuses: "candidate", "accepted", "applied", "rejected", "remaining", "downgraded".
- Bucket II statuses: "left for user decision", "deferred", "kept as-is for now", "implemented after explicit approval".
- designSignal: use exactly one of ${designSignalOptions(", ")}.
- commitMessage: optional ordinary project commit message; never mention the loop, checkpointing, automation, or ids.`;
}

export function phasePrompt(state: LoopState, phase: Phase = state.phase as Phase, options: { currentFingerprint?: WorktreeFingerprint } = {}): string {
	const header = commonHeader(state, phase, options.currentFingerprint);
	const firstInstruction = legacyBaselineCommitMessageAmendInstruction(state) || selectiveBaselineCheckpointInstruction(state);
	const firstAction = firstInstruction ? `\n\n${firstInstruction}` : "";
	const matrix = stateMatrixChecklist(state);
	if (phase === "post-review") {
		return `${header}${firstAction}

Task: review the current diff and nearby architecture. Do not edit code. Record Bucket I candidates only when likely safe for later automatic implementation; record larger decisions in Bucket II.${matrix}

${coreRules(state)}

${schemaReminder(state)}`;
	}

	if (phase === "impl-review") {
		return `${header}${firstAction}

Task: re-verify each actionable Bucket I item against actual code paths and tests. Do not edit code. Mark safe, in-scope, root-cause-fixable items as accepted/remaining; reject, downgrade, or move uncertain items to Bucket II. If related candidates share files or state terms, verify them as one batch and accept/reject the batch together.${matrix}

${coreRules(state)}

${schemaReminder(state)}`;
	}

	return `${header}${firstAction}

Task: implement all accepted Bucket I fixes unless a concrete blocker appears. Keep changes tight, integrated, and validated with existing focused commands. Mark fixed items applied and record codeChanges. Do not implement Bucket II without explicit approval. Apply related accepted items in the same files/state boundary before submitting this phase.${matrix}

${coreRules(state)}

${schemaReminder(state)}`;
}

export function resumePrompt(state: LoopState, options: { currentFingerprint?: WorktreeFingerprint } = {}): string {
	if (state.lifecycle === "finalizing") return finalCommitPrompt(state);
	if (state.lifecycle === "complete" || state.phase === "final-report") return "Post-review-loop is ready to render its final report. Call post_review_loop_get_state if needed.";
	return phasePrompt(state, state.phase, options);
}

export function oneshotPrompt(scope: string, options: { reviewOnly?: boolean } = {}): string {
	const mode = options.reviewOnly ? "review-only: do not edit files" : "review-and-improve: apply straightforward safe fixes automatically";
	const actInstruction = options.reviewOnly
		? "Do not edit files. Report Bucket I findings as recommended-but-not-applied and say review-only mode is why no edits were made."
		: "Apply Bucket I fixes automatically when they are straightforward, materially worthwhile, safe, and inside scope. Implement Bucket II only when the best design-improving path is clear and does not require user taste, domain judgment, rollout choice, compatibility tolerance, or risk acceptance.";

	return `Post-implementation review oneshot. This is a stateless command, not the persistent post-review-loop workflow.

Scope: ${promptLine(scope, 600)}
Mode: ${mode}

Do not call post_review_loop_get_state, post_review_loop_submit_phase_result, or post_review_loop_abort. Do not start, mutate, pause, stop, or report on persistent post-review-loop state. Do not create checkpoint commits, push, or commit unless the user explicitly asks.

Review the code after the implementation exists. Focus on issues that were hard to see upfront and only became obvious once the change touched real interfaces, control flow, state, tests, docs, or module boundaries.

Default anchoring:
- If the scope is "uncommitted changes", inspect git status, git diff, git diff --staged, and untracked files shown by status.
- If the scope names a branch, commit range, file list, feature, or other target, use that target instead.
- Read changed files, nearby interfaces, affected tests, and colocated docs before deciding.
- Distinguish issues introduced by this change from pre-existing debt or concerns merely made visible by the change.
- Identify focused validation commands from the repository's existing workflow.

Review lens:
- Treat findings as evidence about ownership, boundaries, data shape, control flow, module layout, abstraction fit, or future change cost.
- For each meaningful finding, state the visible symptom, expected behavior, broad root cause, and whether it is a simple local mistake or a deeper design signal.
- Classify the design signal as one of: ${designSignalOptions("; ")}.
- Prefer the smallest root-cause refactor that actually improves the codebase's shape, not the smallest tactical patch.
- Prefer the strongest practical improvements over exhaustive lists; usually recommend at most three unless the scope has genuinely independent high-value issues.
- Reject weak, speculative, unrealistic, noisy, overbroad, or overcomplicated recommendations.
- When applying or recommending a straightforward fix, check whether the inspected code makes a broader refactor/redesign plausibly better for the long-term shape. If so, apply the safe fix when allowed, and report the broader option as Bucket II with options, tradeoffs, and why approval is needed. Do not manufacture a refactor comparison when the focused fix is clearly sufficient.
- Do not invent a flaw just to produce feedback; a clean review is valid.
- Avoid tiny helper extractions, naming polish, isolated dedupe, or logging niceties unless they reveal a broader boundary or ownership issue.
- Consider both over-structure and under-structure: unnecessary fields/options/wrappers/strategy points, and flat or mixed modules that make one concern hard to follow.
- For UI labels, disabled states, readiness, permissions, repair actions, or run/resume/complete actions, check related state combinations together.

Review scale / tunnel-vision control:
- Use the lightest review shape that will materially improve confidence. Do not fan out reviewers by default.
- For small or obvious changes, review directly and do a deliberate second pass if needed.
- For moderate non-trivial changes, use at most one fresh-context reviewer when independence is likely to catch issues this review may miss.
- For broad, risky, design-heavy, security-sensitive, or multi-surface changes, use multiple focused reviewers only when distinct risk angles need separate attention.
- For delegated correctness/design reviewers, do not choose a mini/cheap model merely for cost; use the active high-reasoning review model, or the user's explicitly requested review model/thinking such as gpt-5.5 with high thinking.
- Keep reviewer sessions fresh but not context-starved: include the review scope, changed/diff targets, known concerns, expected output shape, and validation expectations; ask the reviewer to inspect files/diffs itself rather than relying only on the briefing.
- Treat reviewer output as leads: verify every accepted finding yourself against the real code path, nearby interfaces, tests, docs, scope, and risk.

Evidence reuse and batching:
- If reviewing the same target as an earlier pass, first verify what changed with git status, relevant diffs, and affected file inspection.
- Reuse inspection facts only for files you can verify are unchanged. Re-inspect changed files and new dependencies needed for the current finding.
- Reuse validation only when the command's relevant inputs are unchanged and that relationship is clear; otherwise rerun the focused command.

Classification:
- Bucket I — Straightforward / Recommended: concrete evidence, clear low-risk fix path, materially worthwhile for correctness/design/ownership/organization, and within scope. ${options.reviewOnly ? "Do not apply in review-only mode." : "Apply it."}
- Bucket II — Design choice / Tradeoff: multiple credible designs, meaningful cost/churn/risk, possible product/domain/architecture judgment, or pre-existing debt outside scope. Prefer the design-improving option; ask before acting only when the tradeoff needs the user's decision.
- Keep As-Is: plausible concern rejected because evidence is weak, current structure earns its keep, or changing it would be overcorrection.

Act:
- ${actInstruction}
- Batch closely related Bucket I items that share files, modules, ownership boundaries, or UI state domains when safe.
- After code changes, rerun focused tests, typechecks, formatters, or other repo-standard checks.
- If validation fails because of your changes, fix it or report the blocker clearly. If unrelated/pre-existing, say so.

Snippet rules:
- When citing existing code, prefer embedded snippets over bare file paths and line numbers.
- Put the source file path on the first line of each snippet.
- Keep snippets tight and evidence-focused: signatures, branches, translations, ownership boundaries, and repeated glue code are usually enough.
- Use file and line references only when a snippet would add noise or the exact location itself is the point.

Output exactly these sections:

### What I Reviewed
Give 1-3 short sentences explaining the reviewed code, behavior, or flow in human terms. If useful, add one concise line distinguishing files reviewed from files edited.

### Applied / Resolved
Number each item. Start with \`[applied]\`. Include what the implementation revealed, designSignal classification, the design/quality weakness, the root-cause fix/refactor applied, why a smaller patch would have been a bandage when relevant, and validation evidence. If empty, say: No automatic changes were applied.

### Needs Decision / Bucket II
Number each remaining decision item. Start with \`[recommended now]\`, \`[deferred]\`, or \`[discussion only]\`. Include what was revealed, designSignal classification, the design weakness, main options, Recommended action, tradeoffs/risks/uncertainty, and why permission is needed before changing. If empty, say: No unresolved Bucket II decisions remain.

### Keep As-Is
Call out meaningful findings rejected after verification and why no change is recommended. Omit tiny non-findings.

### Validation
List validation commands run and results. If no validation was run, explain why.

### Verdict
End with one of: No meaningful improvement identified; Applied straightforward design improvements; Applied improvements; decision needed for remaining tradeoff; Decision needed before refactor; Validation failure remains.`;
}

export function renderReusableEvidenceForStatus(state: LoopState, current?: WorktreeFingerprint): string {
	return reusableEvidenceSection(state, current);
}

export function abortPrompt(reason: string): string {
	return `Post-review-loop stopped: ${reason}\n\nThe extension rendered or can render the deterministic final report from its ledger.`;
}
