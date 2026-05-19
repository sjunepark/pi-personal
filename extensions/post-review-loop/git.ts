import { execFileSync } from "node:child_process";
import type { AfterReviewCommitState, BaselineState, LoopState } from "./types.js";

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

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function loopEditedFiles(state: LoopState): string[] {
	return unique(state.codeChanges.flatMap((item) => item.files));
}

export function scopedFilesFromStatus(cwd: string): string[] {
	const status = safeGit(cwd, ["status", "--short"]);
	if (!status) return [];
	return status
		.split("\n")
		.map((entry) => entry.slice(3).trim())
		.filter(Boolean)
		.map((entry) => entry.replace(/^"|"$/g, ""));
}

export function establishBaseline(cwd: string, scope: string): BaselineState {
	const inside = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") {
		return { ref: "None", mode: "unavailable", createdCommit: false, scopedFiles: [], notes: "Not inside a git work tree." };
	}

	const ref = safeGit(cwd, ["rev-parse", "--short", "HEAD"]) ?? "unknown";
	const scopedFiles = scopedFilesFromStatus(cwd);
	const scopeNote = scope.trim() ? `Scope recorded: ${scope.trim()}` : "No explicit scope text.";
	return {
		ref,
		mode: "existing-head",
		createdCommit: false,
		scopedFiles,
		notes: scopedFiles.length ? `${scopeNote} Dirty scoped files recorded; no automatic commit was created.` : `${scopeNote} Worktree clean at start.`,
	};
}

export function defaultAfterReviewCommit(): AfterReviewCommitState {
	return { ref: "None", mode: "not-needed", files: [] };
}

export function normalizeAfterReviewCommit(state: LoopState): AfterReviewCommitState {
	if (!state.codeChanges.length) return defaultAfterReviewCommit();
	const files = loopEditedFiles(state);
	const failed = state.validation.some((item) => item.result === "failed");
	if (failed) return { ref: "None", mode: "skipped-validation-failed", files };
	if (state.lastGate?.verdict === "Loop stopped: scope or context needed") return { ref: "None", mode: "skipped-scope-blocked", files };
	return { ref: "None", mode: "left-uncommitted", files };
}
