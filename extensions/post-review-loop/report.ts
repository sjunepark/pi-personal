import { countCurrentUnresolvedBucketII, currentBucketIItems, currentBucketIIItems, isActionableBucketI, isUnresolvedBucketII } from "./ledger.js";
import type { BucketIItem, BucketIIItem, CodeChange, LoopState, RejectedItem, ValidationResult } from "./types.js";

const BASELINE_MODE_LABELS: Record<string, string> = {
	"existing-head": "Existing HEAD recorded as before-review baseline",
	"created-before-review": "Before-review commit created",
	"amended-before-review": "Existing before-review commit amended",
	"legacy-wip-baseline": "Legacy WIP baseline recorded",
	unavailable: "Git baseline unavailable",
};

const AFTER_REVIEW_MODE_LABELS: Record<string, string> = {
	"not-needed": "No after-review commit needed",
	"created-after-review": "After-review commit created",
	"amended-after-review": "Before-review checkpoint amended into final project commit",
	"skipped-validation-failed": "Skipped because validation failed",
	"skipped-scope-blocked": "Skipped because scope or context blocked",
	"left-uncommitted": "Loop changes left uncommitted",
	failed: "After-review commit failed; loop changes left uncommitted",
};

function line(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function paragraphs(value: string): string {
	return value
		.trim()
		.split(/\n\s*\n/g)
		.map(line)
		.filter(Boolean)
		.join("\n\n");
}

function list(values: string[], empty = "None", limit?: number): string {
	const cleaned = values.map(line).filter(Boolean);
	if (!cleaned.length) return empty;
	const shown = limit ? cleaned.slice(0, limit) : cleaned;
	const suffix = limit && cleaned.length > limit ? `, +${cleaned.length - limit} more` : "";
	return `${shown.join(", ")}${suffix}`;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map(line).filter(Boolean)));
}

function normalizedKey(value: string): string {
	return line(value).toLowerCase();
}

function loopEditedFiles(state: LoopState): string[] {
	return unique(state.codeChanges.flatMap((item) => item.files));
}

function renderFileScopeLines(state: LoopState, options: { compact?: boolean } = { compact: true }): string[] {
	const limit = options.compact === false ? undefined : 8;
	return [`- Files reviewed / in submitted phase scope: ${list(state.filesChanged, "None", limit)}`, `- Files edited by loop: ${list(loopEditedFiles(state), "None", limit)}`];
}

function renderBaselineLines(state: LoopState, baselineKind: string): string[] {
	return [
		`- Before-review baseline: \`${state.baseline.ref}\` (${baselineKind})`,
		state.baseline.originalRef ? `- Original HEAD before loop: \`${state.baseline.originalRef}\`` : undefined,
		state.baseline.checkpointRef ? `- Start checkpoint commit: \`${state.baseline.checkpointRef}\`` : undefined,
		`- Baseline notes: ${line(state.baseline.notes)}`,
	].filter((item): item is string => Boolean(item));
}

function renderAfterReviewLines(state: LoopState, afterReviewKind: string): string[] {
	return [
		`- After-review commit: \`${state.afterReviewCommit.ref}\` (${afterReviewKind})`,
		state.afterReviewCommit.notes ? `- After-review notes: ${line(state.afterReviewCommit.notes)}` : undefined,
	].filter((item): item is string => Boolean(item));
}

function escapeTable(value: string): string {
	return line(value).replace(/\|/g, "\\|");
}

function validationKey(record: ValidationResult): string {
	return `${record.command}\u0000${record.result}`;
}

function groupedValidation(records: ValidationResult[]): Array<ValidationResult & { count: number; phases: string[] }> {
	const byKey = new Map<string, ValidationResult & { count: number; phases: string[] }>();
	for (const record of records) {
		const key = validationKey(record);
		const previous = byKey.get(key);
		if (previous) {
			previous.count += 1;
			previous.notes = record.notes;
			previous.phase = record.phase;
			previous.phases = unique([...previous.phases, record.phase]);
			continue;
		}
		byKey.set(key, { ...record, count: 1, phases: [record.phase] });
	}
	return Array.from(byKey.values());
}

function renderValidationSummary(records: ValidationResult[]): string {
	if (!records.length) return "No validation commands were recorded.";
	const rows = ["| Command | Result | Count | Latest note |", "| --- | --- | ---: | --- |"];
	for (const record of groupedValidation(records)) rows.push(`| ${escapeTable(record.command)} | ${record.result} | ${record.count} | ${escapeTable(record.notes)} |`);
	return rows.join("\n");
}

function renderValidationFull(records: ValidationResult[]): string {
	if (!records.length) return "No validation commands were recorded.";
	const rows = ["| Command | Result | Phase | Notes |", "| --- | --- | --- | --- |"];
	for (const record of records) rows.push(`| ${escapeTable(record.command)} | ${record.result} | ${record.phase} | ${escapeTable(record.notes)} |`);
	return rows.join("\n");
}

function renderBucketI(records: BucketIItem[], empty = "No Bucket I findings were found."): string {
	if (!records.length) return empty;
	return records
		.map(
			(item, index) => `${index + 1}. ${line(item.title)}
   - Revealed: ${line(item.revealed)}
   - Status: ${item.status}
   - Root-cause fix/refactor: ${line(item.fix)}
   - Files changed: ${list(item.files)}
   - Bandage avoided: ${line(item.bandageReason)}
   - Validation evidence: ${list(item.validation)}`,
		)
		.join("\n\n");
}

function renderBucketICompact(records: BucketIItem[], empty = "No Bucket I findings were found."): string {
	if (!records.length) return empty;
	return records.map((item) => `- [${item.status}] ${line(item.title)} (${list(item.files, "no files", 5)})`).join("\n");
}

function bucketIOutcomeGroups(records: BucketIItem[]): { applied: BucketIItem[]; actionable: BucketIItem[]; closedWithoutFix: BucketIItem[] } {
	return {
		applied: records.filter((item) => item.status === "applied"),
		actionable: records.filter(isActionableBucketI),
		closedWithoutFix: records.filter((item) => item.status === "rejected" || item.status === "downgraded"),
	};
}

function bucketIOutcomeSummary(records: BucketIItem[]): string {
	const groups = bucketIOutcomeGroups(records);
	return `${groups.applied.length} applied / ${groups.actionable.length} still actionable / ${groups.closedWithoutFix.length} rejected or downgraded`;
}

function cleanCondition(state: LoopState, records: BucketIItem[], verdict: string, hasStopGate: boolean): string {
	if (state.finalCleanCondition) return state.finalCleanCondition;
	const actionable = bucketIOutcomeGroups(records).actionable;
	if (actionable.length) return `${actionable.length} Bucket I item(s) remain actionable and were not applied.`;
	if (hasStopGate && verdict.startsWith("Loop clean")) return "No accepted/actionable Bucket I findings remain.";
	return "Loop stopped before clean condition was proven.";
}

function renderBucketIOutcomeSectionsFull(records: BucketIItem[]): string {
	if (!records.length) return "No Bucket I findings were found.";
	const { applied, actionable, closedWithoutFix } = bucketIOutcomeGroups(records);
	return [
		"### Applied by the Loop",
		"Bucket I items with status `applied`. These should also have implementation detail in `Code Changes Applied`.",
		"",
		renderBucketI(applied, "No Bucket I fixes were applied by the loop."),
		"",
		"### Still Actionable / Not Yet Applied",
		"Bucket I items still marked `candidate`, `accepted`, or `remaining`. These were not fixed by this loop report's current ledger state.",
		"",
		renderBucketI(actionable, "No unapplied actionable Bucket I items remain."),
		"",
		"### Rejected or Downgraded",
		"Bucket I items the loop decided not to fix as Bucket I work.",
		"",
		renderBucketI(closedWithoutFix, "No Bucket I items were rejected or downgraded."),
	].join("\n");
}

function renderBucketIOutcomeSectionsCompact(records: BucketIItem[]): string {
	if (!records.length) return "No Bucket I findings were found.";
	const { applied, actionable, closedWithoutFix } = bucketIOutcomeGroups(records);
	return [
		"### Applied fixes",
		renderBucketICompact(applied, "No Bucket I fixes were applied by the loop."),
		"",
		"### Still actionable",
		renderBucketICompact(actionable, "No unapplied actionable Bucket I items remain."),
		"",
		closedWithoutFix.length ? `### Rejected or downgraded\n${renderBucketICompact(closedWithoutFix)}` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join("\n");
}

function renderBucketII(records: BucketIIItem[]): string {
	if (!records.length) return "No Bucket II findings were found.";
	return records
		.map(
			(item, index) => `${index + 1}. ${line(item.title)}
   - Revealed: ${line(item.revealed)}
   - Design or quality weakness: ${line(item.weakness)}
   - Options / decision points: ${list(item.options)}
   - Recommended action: ${line(item.recommendedAction)}
   - Tradeoffs / uncertainty: ${line(item.tradeoffs)}
   - Status: ${item.status}`,
		)
		.join("\n\n");
}

function renderBucketIICompact(records: BucketIIItem[]): string {
	if (!records.length) return "No Bucket II findings were found.";
	return records
		.map((item) => {
			const recommendation = isUnresolvedBucketII(item) ? ` — ${line(item.recommendedAction)}` : "";
			return `- [${item.status}] ${line(item.title)}${recommendation}`;
		})
		.join("\n");
}

function renderCodeChanges(records: CodeChange[]): string {
	if (!records.length) return "No code changes were applied by the loop.";
	return records
		.map(
			(item, index) => `${index + 1}. ${line(item.title)}
   - Files: ${list(item.files)}
   - Issue addressed: ${line(item.issueAddressed)}
   - Why this scope: ${line(item.scopeReason)}
   - Validation evidence: ${list(item.validation)}
   - Inspect with: \`${line(item.inspect)}\``,
		)
		.join("\n\n");
}

function renderCodeChangesCompact(records: CodeChange[]): string {
	if (!records.length) return "No code changes were applied by the loop.";
	return records.map((item) => `- ${line(item.title)} (${list(item.files, "no files", 5)})`).join("\n");
}

function dedupeRejected(records: RejectedItem[]): RejectedItem[] {
	const byTitle = new Map<string, RejectedItem>();
	for (const item of records) byTitle.set(normalizedKey(item.title), item);
	return Array.from(byTitle.values());
}

function renderRejected(records: RejectedItem[]): string {
	const uniqueRecords = dedupeRejected(records);
	if (!uniqueRecords.length) return "None.";
	return uniqueRecords.map((item) => `- ${line(item.title)}: ${line(item.reason)}`).join("\n");
}

function renderPhases(state: LoopState): string {
	if (!state.phasesRun.length) return "None recorded.";
	return state.phasesRun.map((item) => `- Iteration ${item.iteration} \`${item.phase}\` — ${line(item.gateDecision)}`).join("\n");
}

export function renderReviewSummary(state: LoopState): string {
	const target = line(state.scope);
	const briefing = state.reviewTargetBriefing?.trim() || state.phasesRun.find((item) => item.phase === "post-review")?.summary || "No completed review target briefing yet.";
	return `**Review target: ${target}**\n\n${paragraphs(briefing)}`;
}

export function renderCurrentReport(state: LoopState, options: { full?: boolean } = {}): string {
	return options.full ? renderCurrentReportFull(state) : renderCurrentReportConcise(state);
}

function renderCurrentReportConcise(state: LoopState): string {
	const currentBucketI = currentBucketIItems(state.bucketI);
	const currentBucketII = currentBucketIIItems(state.bucketII);
	const unresolvedBucketII = countCurrentUnresolvedBucketII(state.bucketII);
	return [
		"# Post-Review Loop Current Status",
		"",
		`- Lifecycle: ${state.lifecycle}`,
		`- Current phase: ${state.phase}`,
		`- Iterations: ${state.iteration}/${state.limit}`,
		`- Scope: ${line(state.scope)}`,
		`- Bucket I: ${bucketIOutcomeSummary(currentBucketI)}`,
		`- Bucket II: ${unresolvedBucketII}/${currentBucketII.length} unresolved/current`,
		`- Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${line(state.lastGate.reason)}` : "none"}`,
		"",
		"## What Was Reviewed",
		"",
		renderReviewSummary(state),
		"",
		"## Bucket I",
		"",
		renderBucketIOutcomeSectionsCompact(currentBucketI),
		"",
		"## Remaining Decisions",
		"",
		renderBucketIICompact(currentBucketII),
		"",
		"## Validation Summary",
		"",
		renderValidationSummary(state.validation),
		"",
		"## Files",
		"",
		...renderFileScopeLines(state),
		"",
	].join("\n");
}

function renderCurrentReportFull(state: LoopState): string {
	const baselineKind = BASELINE_MODE_LABELS[state.baseline.mode] ?? state.baseline.mode;
	const afterReviewKind = AFTER_REVIEW_MODE_LABELS[state.afterReviewCommit.mode] ?? state.afterReviewCommit.mode;
	const currentBucketI = currentBucketIItems(state.bucketI);
	const currentBucketII = currentBucketIIItems(state.bucketII);
	const unresolvedBucketII = countCurrentUnresolvedBucketII(state.bucketII);
	return [
		"# Post-Implementation Review Loop Current Ledger",
		"",
		"This is an in-progress ledger preview. It is not a final report and does not stop the loop.",
		"",
		"## Current Status",
		"",
		`- Lifecycle: ${state.lifecycle}`,
		`- Current phase: ${state.phase}`,
		`- Iterations: ${state.iteration}/${state.limit}`,
		`- Scope: ${line(state.scope)}`,
		...renderBaselineLines(state, baselineKind),
		...renderAfterReviewLines(state, afterReviewKind),
		...renderFileScopeLines(state, { compact: false }),
		`- Bucket I current findings: ${currentBucketI.length} (${state.bucketI.length} ledger entries; ${bucketIOutcomeSummary(currentBucketI)})`,
		`- Bucket II unresolved/current findings: ${unresolvedBucketII}/${currentBucketII.length} (${state.bucketII.length} stored entries)`,
		`- Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${line(state.lastGate.reason)}` : "none"}`,
		"- Verdict: in progress — no final verdict has been rendered",
		"",
		"## What Was Reviewed",
		"",
		renderReviewSummary(state),
		"",
		"## Phases Run",
		"",
		renderPhases(state),
		"",
		"## Validation",
		"",
		renderValidationFull(state.validation),
		"",
		"## Bucket I — Current Findings by Outcome",
		"",
		renderBucketIOutcomeSectionsFull(currentBucketI),
		"",
		"## Bucket II — Findings and Recommendations",
		"",
		renderBucketII(currentBucketII),
		"",
		"## Code Changes Applied",
		"",
		renderCodeChanges(state.codeChanges),
		"",
		"## Rejected / Kept As-Is",
		"",
		renderRejected(state.rejectedOrKeptAsIs),
		"",
	].join("\n");
}

export function renderFinalReport(state: LoopState, options: { full?: boolean } = {}): string {
	return options.full ? renderFinalReportFull(state) : renderFinalReportConcise(state);
}

function finalFacts(state: LoopState): { verdict: string; stopReason: string; finalCleanCondition: string; currentBucketI: BucketIItem[]; currentBucketII: BucketIIItem[] } {
	const stopGate = state.lastGate?.decision === "stop" ? state.lastGate : undefined;
	const hasStopGate = Boolean(stopGate);
	const verdict = stopGate?.verdict ?? "Loop stopped: scope or context needed";
	const stopReason = state.lastGate?.reason ?? "report requested before a final stop gate";
	const currentBucketI = currentBucketIItems(state.bucketI);
	return {
		verdict,
		stopReason,
		finalCleanCondition: cleanCondition(state, currentBucketI, verdict, hasStopGate),
		currentBucketI,
		currentBucketII: currentBucketIIItems(state.bucketII),
	};
}

function renderFinalReportConcise(state: LoopState): string {
	const { verdict, stopReason, finalCleanCondition, currentBucketI, currentBucketII } = finalFacts(state);
	const unresolvedBucketII = countCurrentUnresolvedBucketII(state.bucketII);
	return [
		"# Post-Review Loop Report",
		"",
		"## Summary",
		"",
		`- Verdict: ${verdict}`,
		`- Stop reason: ${line(stopReason)}`,
		`- Clean condition: ${line(finalCleanCondition)}`,
		`- Iterations: ${state.iteration}/${state.limit}`,
		`- Bucket I: ${bucketIOutcomeSummary(currentBucketI)}`,
		`- Bucket II: ${unresolvedBucketII}/${currentBucketII.length} unresolved/current`,
		"",
		"## What Was Reviewed",
		"",
		renderReviewSummary(state),
		"",
		"## Bucket I Outcomes",
		"",
		renderBucketIOutcomeSectionsCompact(currentBucketI),
		"",
		"## Remaining Decisions",
		"",
		renderBucketIICompact(currentBucketII),
		"",
		"## Validation Summary",
		"",
		renderValidationSummary(state.validation),
		"",
		"## Files Changed Summary",
		"",
		...renderFileScopeLines(state),
		"",
		"## Code Changes Applied",
		"",
		renderCodeChangesCompact(state.codeChanges),
		"",
	].join("\n");
}

function renderFinalReportFull(state: LoopState): string {
	const baselineKind = BASELINE_MODE_LABELS[state.baseline.mode] ?? state.baseline.mode;
	const afterReviewKind = AFTER_REVIEW_MODE_LABELS[state.afterReviewCommit.mode] ?? state.afterReviewCommit.mode;
	const { verdict, stopReason, finalCleanCondition, currentBucketI, currentBucketII } = finalFacts(state);
	const finalDiffInspection = state.finalDiffInspection ?? "Inspect the reviewed/edited file lists and validation table above.";

	return [
		"# Post-Implementation Review Loop Report",
		"",
		"## Summary",
		"",
		...renderBaselineLines(state, baselineKind),
		`- Before-review scoped files: ${list(state.baseline.scopedFiles)}`,
		...renderAfterReviewLines(state, afterReviewKind),
		`- After-review files: ${list(state.afterReviewCommit.files)}`,
		`- Scope: ${line(state.scope)}`,
		`- Iterations: ${state.iteration}/${state.limit}`,
		...renderFileScopeLines(state, { compact: false }),
		`- Bucket I outcome: ${bucketIOutcomeSummary(currentBucketI)}`,
		`- Stop reason: ${line(stopReason)}`,
		`- Final clean condition: ${line(finalCleanCondition)}`,
		`- Final diff / validation confirmation: ${line(finalDiffInspection)}`,
		`- Verdict: ${verdict}`,
		"",
		"## What Was Reviewed",
		"",
		renderReviewSummary(state),
		"",
		"## Phases Run",
		"",
		renderPhases(state),
		"",
		"## Validation",
		"",
		renderValidationFull(state.validation),
		"",
		"## Bucket I — Findings by Outcome",
		"",
		renderBucketIOutcomeSectionsFull(currentBucketI),
		"",
		"## Bucket II — Findings and Recommendations",
		"",
		renderBucketII(currentBucketII),
		"",
		"## Code Changes Applied",
		"",
		renderCodeChanges(state.codeChanges),
		"",
		"## Rejected / Kept As-Is",
		"",
		renderRejected(state.rejectedOrKeptAsIs),
		"",
		"## Final Verdict",
		"",
		verdict,
		"",
	].join("\n");
}
