import { countCurrentUnresolvedBucketII, currentBucketIItems, currentBucketIIItems } from "./ledger.js";
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
	"amended-after-review": "Existing after-review commit amended",
	"skipped-validation-failed": "Skipped because validation failed",
	"skipped-scope-blocked": "Skipped because scope or context blocked",
	"left-uncommitted": "Loop changes left uncommitted",
};

function line(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function list(values: string[], empty = "None"): string {
	const cleaned = values.map(line).filter(Boolean);
	return cleaned.length ? cleaned.join(", ") : empty;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map(line).filter(Boolean)));
}

function loopEditedFiles(state: LoopState): string[] {
	return unique(state.codeChanges.flatMap((item) => item.files));
}

function renderFileScopeLines(state: LoopState): string[] {
	return [`- Files reviewed / in submitted phase scope: ${list(state.filesChanged)}`, `- Files edited by loop: ${list(loopEditedFiles(state))}`];
}

function escapeTable(value: string): string {
	return line(value).replace(/\|/g, "\\|");
}

function renderValidation(records: ValidationResult[]): string {
	if (!records.length) return "No validation commands were recorded.";
	const rows = ["| Command | Result | Phase | Notes |", "| --- | --- | --- | --- |"];
	for (const record of records) {
		rows.push(`| ${escapeTable(record.command)} | ${record.result} | ${record.phase} | ${escapeTable(record.notes)} |`);
	}
	return rows.join("\n");
}

function renderBucketI(records: BucketIItem[]): string {
	if (!records.length) return "No Bucket I findings were found.";
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

function renderRejected(records: RejectedItem[]): string {
	if (!records.length) return "None.";
	return records.map((item) => `- ${line(item.title)}: ${line(item.reason)}`).join("\n");
}

function renderPhases(state: LoopState): string {
	if (!state.phasesRun.length) return "None recorded.";
	return state.phasesRun
		.map((item) => `- Iteration ${item.iteration} \`${item.phase}\` — ${line(item.gateDecision)}; ${line(item.summary)}`)
		.join("\n");
}

export function renderCurrentReport(state: LoopState): string {
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
		`- Before-review baseline: \`${state.baseline.ref}\` (${baselineKind})`,
		`- After-review commit: \`${state.afterReviewCommit.ref}\` (${afterReviewKind})`,
		...renderFileScopeLines(state),
		`- Bucket I current findings: ${currentBucketI.length} (${state.bucketI.length} ledger entries)`,
		`- Bucket II unresolved/current findings: ${unresolvedBucketII}/${currentBucketII.length} (${state.bucketII.length} stored entries)`,
		`- Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${line(state.lastGate.reason)}` : "none"}`,
		"- Verdict: in progress — no final verdict has been rendered",
		"",
		"## Phases Run",
		"",
		renderPhases(state),
		"",
		"## Validation",
		"",
		renderValidation(state.validation),
		"",
		"## Bucket I — Current Findings and Fixes",
		"",
		renderBucketI(currentBucketI),
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

export function renderFinalReport(state: LoopState): string {
	const baselineKind = BASELINE_MODE_LABELS[state.baseline.mode] ?? state.baseline.mode;
	const afterReviewKind = AFTER_REVIEW_MODE_LABELS[state.afterReviewCommit.mode] ?? state.afterReviewCommit.mode;
	const hasStopGate = state.lastGate?.decision === "stop";
	const verdict = hasStopGate ? state.lastGate!.verdict : "Loop stopped: scope or context needed";
	const stopReason = state.lastGate?.reason ?? "report requested before a final stop gate";
	const finalCleanCondition = state.finalCleanCondition ?? (hasStopGate && verdict.startsWith("Loop clean") ? "No accepted/actionable Bucket I findings remain." : "Loop stopped before clean condition was proven.");
	const finalDiffInspection = state.finalDiffInspection ?? "Inspect the reviewed/edited file lists and validation table above.";
	const currentBucketII = currentBucketIIItems(state.bucketII);

	return [
		"# Post-Implementation Review Loop Report",
		"",
		"## Summary",
		"",
		`- Before-review baseline: \`${state.baseline.ref}\` (${baselineKind})`,
		`- Before-review scoped files: ${list(state.baseline.scopedFiles)}`,
		`- After-review commit: \`${state.afterReviewCommit.ref}\` (${afterReviewKind})`,
		`- After-review files: ${list(state.afterReviewCommit.files)}`,
		`- Scope: ${line(state.scope)}`,
		`- Iterations: ${state.iteration}/${state.limit}`,
		...renderFileScopeLines(state),
		`- Stop reason: ${line(stopReason)}`,
		`- Final clean condition: ${line(finalCleanCondition)}`,
		`- Final diff / validation confirmation: ${line(finalDiffInspection)}`,
		`- Verdict: ${verdict}`,
		"",
		"## Phases Run",
		"",
		renderPhases(state),
		"",
		"## Validation",
		"",
		renderValidation(state.validation),
		"",
		"## Bucket I — Findings and Fixes",
		"",
		renderBucketI(state.bucketI),
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
