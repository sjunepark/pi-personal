import { execFileSync } from "node:child_process";
import type { AfterReviewCommitState, BaselineState, CommitMessage, LoopState, ValidationResult } from "./types.js";

const DEFAULT_REVIEW_SCOPE = "uncommitted changes";
const BEFORE_REVIEW_SUBJECT = "checkpoint(post-review-loop): before review";

type BaselineOptions = { checkpoint: boolean };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeGit(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args);
	} catch {
		return undefined;
	}
}

function gitQuiet(cwd: string, args: string[]): boolean {
	try {
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function loopEditedFiles(state: LoopState): string[] {
	return unique(state.codeChanges.flatMap((item) => item.files));
}

function clean(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function bulletList(values: string[], empty = "- none"): string {
	const cleaned = values.map(clean).filter(Boolean);
	return cleaned.length ? cleaned.map((value) => `- ${value}`).join("\n") : empty;
}

function validationLines(records: ValidationResult[]): string[] {
	return records.map((record) => `${record.command}: ${record.result} — ${record.notes}`);
}

function firstSentence(value: string): string {
	return clean(value).replace(/[.!?]$/, "");
}

function subjectFromTitle(title: string, prefix: "feat" | "fix"): string {
	const cleaned = firstSentence(title);
	if (/^[a-z]+(\([^)]+\))?!?:\s/.test(cleaned)) return cleaned;
	const withoutDuplicatedVerb = prefix === "fix" ? cleaned.replace(/^(fix|fixes|resolve|resolves|correct|corrects|repair|repairs)\s+/i, "") : cleaned;
	return `${prefix}: ${withoutDuplicatedVerb.charAt(0).toLowerCase()}${withoutDuplicatedVerb.slice(1)}`;
}

function fallbackCommitMessage(state: LoopState): CommitMessage {
	const title = state.codeChanges[0]?.title ?? state.phasesRun.find((item) => item.phase === "post-review")?.summary ?? state.reviewTargetBriefing ?? "update reviewed implementation";
	const prefix = state.codeChanges.length ? "fix" : "feat";
	const body = [
		state.reviewTargetBriefing ? firstSentence(state.reviewTargetBriefing) : undefined,
		state.codeChanges.length ? ["Review fixes:", bulletList(state.codeChanges.map((item) => item.title))].join("\n") : undefined,
		state.validation.length ? ["Validation:", bulletList(validationLines(state.validation))].join("\n") : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
	return { subject: subjectFromTitle(title, prefix), body: body || undefined };
}

function finalCommitMessage(state: LoopState): CommitMessage {
	const explicit = state.commitMessage;
	if (explicit?.subject.trim()) return { subject: clean(explicit.subject), body: explicit.body?.trim() };
	return fallbackCommitMessage(state);
}

function commit(cwd: string, message: CommitMessage, options: { amend?: boolean } = {}): void {
	const args = ["commit"];
	if (options.amend) args.push("--amend");
	args.push("-m", message.subject);
	if (message.body?.trim()) args.push("-m", message.body.trim());
	git(cwd, args);
}

function assertSafeToCreateCheckpoint(cwd: string): void {
	if (safeGit(cwd, ["rev-parse", "--verify", "MERGE_HEAD"])) throw new Error("Cannot create a post-review-loop checkpoint during an active merge.");
	if (safeGit(cwd, ["rev-parse", "--verify", "REBASE_HEAD"])) throw new Error("Cannot create a post-review-loop checkpoint during an active rebase.");
}

function stageAll(cwd: string): void {
	git(cwd, ["add", "-A"]);
}

function hasStagedChanges(cwd: string): boolean {
	return !gitQuiet(cwd, ["diff", "--cached", "--quiet", "--"]);
}

function isCurrentHead(cwd: string, ref: string | undefined): boolean {
	if (!ref) return false;
	return safeGit(cwd, ["rev-parse", "--short", "HEAD"]) === ref;
}

function afterReviewFiles(state: LoopState, statusFiles: string[]): string[] {
	return unique([...state.baseline.scopedFiles, ...loopEditedFiles(state), ...statusFiles]);
}

function shouldReplaceDefaultScope(scope: string): boolean {
	return clean(scope) === DEFAULT_REVIEW_SCOPE;
}

function hasHeadReference(scope: string): boolean {
	return /(^|[^A-Za-z0-9_\/-])HEAD($|[^A-Za-z0-9_\/-])/.test(scope);
}

function freezeHeadReferenceScope(scope: string, originalFullRef: string | undefined): { reviewScope?: string; blockedReason?: string } {
	if (shouldReplaceDefaultScope(scope) || !hasHeadReference(scope)) return {};
	if (!originalFullRef) return { blockedReason: "HEAD-relative scope could not be frozen because the original HEAD could not be resolved." };

	const frozen = scope.replace(/(^|[^A-Za-z0-9_\/-])HEAD(?=$|[\s.,:~^])/g, (_match, prefix: string) => `${prefix}${originalFullRef}`);
	if (hasHeadReference(frozen)) return { blockedReason: "HEAD-relative scope uses a form that cannot be safely frozen before checkpointing." };
	return frozen === scope ? {} : { reviewScope: frozen };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function scopedFilesFromStatus(cwd: string): string[] {
	const status = safeGit(cwd, ["status", "--short"]);
	if (!status) return [];
	return status
		.split("\n")
		.map((entry) => entry.slice(2).trim())
		.filter(Boolean)
		.map((entry) => entry.replace(/^"|"$/g, ""));
}

export function establishBaseline(cwd: string, scope: string, options: BaselineOptions = { checkpoint: true }): BaselineState {
	const inside = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") {
		return { ref: "None", mode: "unavailable", createdCommit: false, scopedFiles: [], notes: "Not inside a git work tree." };
	}

	const originalRef = safeGit(cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
	const originalFullRef = safeGit(cwd, ["rev-parse", "--verify", "HEAD"]);
	const scopedFiles = scopedFilesFromStatus(cwd);
	const scopeNote = scope.trim() ? `Scope recorded: ${scope.trim()}` : "No explicit scope text.";
	const frozenScope = freezeHeadReferenceScope(scope, originalFullRef);
	if (!scopedFiles.length) {
		return {
			ref: originalRef,
			mode: "existing-head",
			createdCommit: false,
			scopedFiles,
			notes: `${scopeNote} Worktree clean at start; no checkpoint commit was needed.`,
			originalRef,
		};
	}

	if (!options.checkpoint) {
		return {
			ref: originalRef,
			mode: "existing-head",
			createdCommit: false,
			scopedFiles,
			notes: `${scopeNote} Dirty scoped files recorded; checkpoint commit disabled by user.`,
			originalRef,
		};
	}

	if (frozenScope.blockedReason) {
		return {
			ref: originalRef,
			mode: "existing-head",
			createdCommit: false,
			scopedFiles,
			notes: `${scopeNote} ${frozenScope.blockedReason} Checkpoint commit skipped to keep the review scope deterministic.`,
			originalRef,
		};
	}

	assertSafeToCreateCheckpoint(cwd);
	stageAll(cwd);
	if (!hasStagedChanges(cwd)) {
		return {
			ref: originalRef,
			mode: "existing-head",
			createdCommit: false,
			scopedFiles,
			notes: `${scopeNote} Dirty status cleared after staging; no checkpoint commit was created.`,
			originalRef,
		};
	}

	commit(cwd, {
		subject: BEFORE_REVIEW_SUBJECT,
		body: [
			"Created automatically by post-review-loop before review edits.",
			`Original HEAD: ${originalRef}`,
			`Requested scope: ${clean(scope) || "none"}`,
			frozenScope.reviewScope ? `Frozen review scope: ${clean(frozenScope.reviewScope)}` : undefined,
			"",
			"Checkpoint files:",
			bulletList(scopedFiles),
		]
			.filter((line): line is string => line !== undefined)
			.join("\n"),
	});
	const checkpointRef = safeGit(cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
	return {
		ref: checkpointRef,
		mode: "created-before-review",
		createdCommit: true,
		scopedFiles,
		notes: `${scopeNote} Created before-review checkpoint commit ${checkpointRef} from ${originalRef}.${frozenScope.reviewScope ? ` Frozen review scope: ${frozenScope.reviewScope}.` : ""}`,
		originalRef,
		checkpointRef,
		reviewScope: shouldReplaceDefaultScope(scope) ? `${originalRef}..${checkpointRef}` : frozenScope.reviewScope,
	};
}

export function defaultAfterReviewCommit(): AfterReviewCommitState {
	return { ref: "None", mode: "not-needed", files: [] };
}

export function normalizeAfterReviewCommit(state: LoopState): AfterReviewCommitState {
	if (state.afterReviewCommit.mode === "created-after-review" || state.afterReviewCommit.mode === "amended-after-review" || state.afterReviewCommit.mode === "failed") return state.afterReviewCommit;
	const files = loopEditedFiles(state);
	const skippedFiles = files.length ? files : state.baseline.scopedFiles;
	const failed = state.validation.some((item) => item.result === "failed");
	if (failed) return { ref: "None", mode: "skipped-validation-failed", files: skippedFiles };
	if (state.lastGate?.decision === "stop" && state.lastGate.verdict === "Loop stopped: scope or context needed") return { ref: "None", mode: "skipped-scope-blocked", files: skippedFiles };
	if (!state.codeChanges.length) return defaultAfterReviewCommit();
	return { ref: "None", mode: "left-uncommitted", files };
}

export function failedAfterReviewCommit(cwd: string, state: LoopState, error: unknown): AfterReviewCommitState {
	const normalized = normalizeAfterReviewCommit(state);
	const files = scopedFilesFromStatus(cwd);
	return {
		ref: "None",
		mode: "failed",
		files: files.length ? files : normalized.files,
		notes: `After-review commit failed: ${clean(errorMessage(error))}`,
	};
}

export function createAfterReviewCommit(cwd: string, state: LoopState): AfterReviewCommitState {
	const normalized = normalizeAfterReviewCommit(state);
	const inside = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return normalized;

	const canAmendBaseline = state.baseline.createdCommit && isCurrentHead(cwd, state.baseline.checkpointRef);
	if (normalized.mode !== "left-uncommitted" && !(normalized.mode === "not-needed" && canAmendBaseline)) return normalized;

	assertSafeToCreateCheckpoint(cwd);
	const filesBeforeStage = scopedFilesFromStatus(cwd);
	const files = afterReviewFiles(state, filesBeforeStage);
	const message = finalCommitMessage(state);

	if (canAmendBaseline) {
		if (normalized.mode === "left-uncommitted") stageAll(cwd);
		commit(cwd, message, { amend: true });
		const ref = safeGit(cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
		return {
			ref,
			mode: "amended-after-review",
			files,
			notes: `Amended temporary before-review checkpoint ${state.baseline.checkpointRef ?? "unknown"} into a normal project commit.`,
		};
	}

	if (!filesBeforeStage.length) return { ref: "None", mode: "not-needed", files: [] };
	stageAll(cwd);
	if (!hasStagedChanges(cwd)) return { ref: "None", mode: "not-needed", files };
	commit(cwd, message);
	const ref = safeGit(cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
	return { ref, mode: "created-after-review", files, notes: "Created a normal project commit for applied review-loop changes." };
}
