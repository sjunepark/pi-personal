import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { AfterReviewCommitState, BaselineState, CommitMessage, LoopState, ValidationResult, WorktreeFingerprint } from "./types.js";

const DEFAULT_REVIEW_SCOPE = "uncommitted changes";
const NON_PROJECT_COMMIT_MESSAGE_PATTERN = /\bcheckpoint(?:ing)?\b|post-review-loop|post review loop/i;

type BaselineOptions = { checkpoint: boolean };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitRaw(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeGit(cwd: string, args: string[]): string | undefined {
	try {
		return git(cwd, args);
	} catch {
		return undefined;
	}
}

function safeGitRaw(cwd: string, args: string[]): string | undefined {
	try {
		return gitRaw(cwd, args);
	} catch {
		return undefined;
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

function mentionsReviewLoopMetadata(value: string | undefined): boolean {
	return value ? NON_PROJECT_COMMIT_MESSAGE_PATTERN.test(value) : false;
}

function ordinaryProjectCommitMessage(message: CommitMessage): CommitMessage | undefined {
	const subject = clean(message.subject);
	const body = message.body?.trim();
	if (!subject) return undefined;
	if (mentionsReviewLoopMetadata(subject) || mentionsReviewLoopMetadata(body)) return undefined;
	return { subject, body };
}

function finalCommitMessage(state: LoopState): CommitMessage {
	const explicit = state.commitMessage;
	if (explicit?.subject.trim()) {
		const ordinary = ordinaryProjectCommitMessage(explicit);
		if (ordinary) return ordinary;
	}
	const fallback = fallbackCommitMessage(state);
	return ordinaryProjectCommitMessage(fallback) ?? { subject: "feat: update reviewed implementation" };
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

function stageFiles(cwd: string, files: string[]): void {
	const cleaned = unique(files).map((file) => safeRepoPath(cwd, file)).filter((file): file is string => Boolean(file));
	if (!cleaned.length) return;
	git(cwd, ["add", "--", ...cleaned]);
}

function isCurrentHead(cwd: string, ref: string | undefined): boolean {
	if (!ref) return false;
	return safeGit(cwd, ["rev-parse", "--short", "HEAD"]) === ref;
}

function afterReviewFiles(state: LoopState): string[] {
	const baselineFiles = state.baseline.createdCommit ? state.baseline.scopedFiles : [];
	return unique([...baselineFiles, ...loopEditedFiles(state)]);
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

function untrackedFiles(cwd: string): string[] {
	const output = safeGitRaw(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
	if (!output) return [];
	return output.split("\0").map(clean).filter(Boolean).sort();
}

function safeRepoPath(cwd: string, file: string): string | undefined {
	const cleanFile = file.trim().replace(/^"|"$/g, "");
	if (!cleanFile || cleanFile.includes("\0")) return undefined;
	const absolute = resolve(cwd, cleanFile);
	const rel = relative(cwd, absolute);
	if (!rel || rel === "." || rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) return undefined;
	return rel.replace(/\\/g, "/");
}

function hashFile(cwd: string, file: string): string | null {
	const absolute = resolve(cwd, file);
	if (!existsSync(absolute)) return null;
	const stat = lstatSync(absolute);
	if (!stat.isFile()) return null;
	return createHash("sha256").update(readFileSync(absolute)).digest("hex");
}

function fileHashMap(cwd: string, files: string[]): Record<string, string | null> {
	const hashes: Record<string, string | null> = {};
	for (const file of unique(files).map((item) => safeRepoPath(cwd, item)).filter((item): item is string => Boolean(item)).sort()) {
		hashes[file] = hashFile(cwd, file);
	}
	return hashes;
}

export function computeWorktreeFingerprint(cwd: string, files: string[] = []): WorktreeFingerprint | undefined {
	const inside = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return undefined;

	const head = safeGit(cwd, ["rev-parse", "HEAD"]) ?? "unknown";
	const stagedDiff = safeGitRaw(cwd, ["diff", "--cached", "--binary", "--"]) ?? "";
	const unstagedDiff = safeGitRaw(cwd, ["diff", "--binary", "--"]) ?? "";
	const status = safeGitRaw(cwd, ["status", "--porcelain=v1", "-uall"]) ?? "";
	const untracked = untrackedFiles(cwd);
	const untrackedHashes = untracked.map((file) => [file, hashFile(cwd, file)] as const);
	const fileHashes = fileHashMap(cwd, files);
	const stagedDiffHash = hashText(stagedDiff);
	const unstagedDiffHash = hashText(unstagedDiff);
	const untrackedHash = hashText(JSON.stringify(untrackedHashes));
	const statusHash = hashText(status);
	const overallHash = hashText(JSON.stringify({ head, stagedDiffHash, unstagedDiffHash, untrackedHash, statusHash }));
	return {
		algorithm: "sha256",
		at: Date.now(),
		head,
		stagedDiffHash,
		unstagedDiffHash,
		untrackedHash,
		untrackedFiles: untracked,
		statusHash,
		overallHash,
		fileHashes,
	};
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

	return {
		ref: originalRef,
		mode: "agent-selected-before-review",
		createdCommit: false,
		scopedFiles,
		notes: `${scopeNote} Dirty scoped files recorded. The first phase prompt asks the agent to create a selective ordinary project commit for only the review-relevant uncommitted changes, leaving unrelated work uncommitted.`,
		originalRef,
		reviewScope: frozenScope.reviewScope,
	};
}

export function defaultAfterReviewCommit(): AfterReviewCommitState {
	return { ref: "None", mode: "not-needed", files: [] };
}

export function normalizeAfterReviewCommit(state: LoopState): AfterReviewCommitState {
	if (
		state.afterReviewCommit.mode === "created-after-review" ||
		state.afterReviewCommit.mode === "amended-after-review" ||
		state.afterReviewCommit.mode === "agent-selected-after-review" ||
		state.afterReviewCommit.mode === "failed"
	) {
		return state.afterReviewCommit;
	}
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

export function needsAgentSelectedAfterReviewCommit(cwd: string, state: LoopState): boolean {
	const normalized = normalizeAfterReviewCommit(state);
	if (normalized.mode !== "left-uncommitted") return false;
	const inside = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return false;
	return !(state.baseline.createdCommit && isCurrentHead(cwd, state.baseline.checkpointRef));
}

export function createAfterReviewCommit(cwd: string, state: LoopState): AfterReviewCommitState {
	const normalized = normalizeAfterReviewCommit(state);
	const inside = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return normalized;

	const canAmendBaseline = state.baseline.createdCommit && isCurrentHead(cwd, state.baseline.checkpointRef);
	if (normalized.mode !== "left-uncommitted" && !(normalized.mode === "not-needed" && canAmendBaseline)) return normalized;
	if (!canAmendBaseline) return normalized;

	assertSafeToCreateCheckpoint(cwd);
	const files = afterReviewFiles(state);
	const message = finalCommitMessage(state);
	if (normalized.mode === "left-uncommitted") stageFiles(cwd, loopEditedFiles(state));
	commit(cwd, message, { amend: true });
	const ref = safeGit(cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
	return {
		ref,
		mode: "amended-after-review",
		files,
		notes: `Amended temporary before-review checkpoint ${state.baseline.checkpointRef ?? "unknown"} into a normal project commit.`,
	};
}
