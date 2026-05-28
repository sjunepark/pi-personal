export type Phase = "post-review" | "impl-review" | "impl";
export type Lifecycle = "active" | "paused" | "checkpointing" | "complete" | "failed";
export type ValidationStatus = "passed" | "failed" | "skipped";
export type ValidationSource = "fresh" | "reused";
export type BucketIStatus = "candidate" | "accepted" | "applied" | "rejected" | "remaining" | "downgraded";
export type BucketIIStatus = "left for user decision" | "deferred" | "kept as-is for now" | "implemented after explicit approval";

export type Verdict =
	| "Loop clean: no accepted/actionable Bucket I findings remain"
	| "Loop stopped: Bucket II decision needed"
	| "Loop stopped: iteration limit reached"
	| "Loop stopped: validation failure remains"
	| "Loop stopped: review-only pass completed"
	| "Loop stopped: Bucket I fixes were not applied"
	| "Loop stopped: user requested stop"
	| "Loop stopped: scope or context needed"
	| "Loop stopped: checkpoint compaction unavailable";

export type ControlRequest = {
	action: "pause" | "stop";
	/** Iteration that was current when the user requested the loop to drain. */
	afterIteration: number;
};

export type BaselineState = {
	ref: string;
	mode: "existing-head" | "created-before-review" | "amended-before-review" | "agent-selected-before-review" | "legacy-wip-baseline" | "unavailable";
	createdCommit: boolean;
	scopedFiles: string[];
	notes: string;
	originalRef?: string;
	checkpointRef?: string;
	reviewScope?: string;
};

export type AfterReviewCommitState = {
	ref: string;
	mode: "not-needed" | "created-after-review" | "amended-after-review" | "skipped-validation-failed" | "skipped-scope-blocked" | "left-uncommitted" | "failed";
	files: string[];
	notes?: string;
};

export type ValidationResult = {
	command: string;
	result: ValidationStatus;
	phase: Phase | "final-report";
	notes: string;
	/** Whether this row was freshly executed in the phase or reused from an unchanged validation cache. */
	source?: ValidationSource;
};

export type BucketIItem = {
	title: string;
	revealed: string;
	status: BucketIStatus;
	fix: string;
	files: string[];
	bandageReason: string;
	validation: string[];
};

export type BucketIIItem = {
	title: string;
	revealed: string;
	weakness: string;
	options: string[];
	recommendedAction: string;
	tradeoffs: string;
	status: BucketIIStatus;
};

export type CodeChange = {
	title: string;
	files: string[];
	issueAddressed: string;
	scopeReason: string;
	validation: string[];
	inspect: string;
};

export type RejectedItem = {
	title: string;
	reason: string;
};

export type CommitMessage = {
	/** Ordinary commit subject to use when finalizing or amending the loop's git checkpoint. */
	subject: string;
	/** Optional body paragraphs or bullets. Must describe the change, not post-review-loop metadata. */
	body?: string;
};

export type PhaseHistoryItem = {
	phase: Phase;
	iteration: number;
	gateDecision: string;
	summary: string;
};

export type WorktreeFingerprint = {
	algorithm: "sha256";
	at: number;
	head: string;
	stagedDiffHash: string;
	unstagedDiffHash: string;
	untrackedHash: string;
	untrackedFiles: string[];
	statusHash: string;
	overallHash: string;
	fileHashes: Record<string, string | null>;
	notes?: string;
};

export type ValidationCacheEntry = {
	command: string;
	cwd: string;
	phase: Phase | "final-report";
	result: ValidationStatus;
	notes: string;
	source: ValidationSource;
	at: number;
	inputKind: "files" | "worktree";
	inputHash: string;
	worktreeHash: string;
	relevantFiles: string[];
	fileHashes?: Record<string, string | null>;
};

export type PhaseEvidenceCache = {
	phase: Phase;
	iteration: number;
	at: number;
	summary: string;
	changedFiles: string[];
	fingerprint: WorktreeFingerprint;
	activeBucketI: Array<Pick<BucketIItem, "title" | "status" | "fix" | "files">>;
	gateDecision: string;
};

export type PhaseResult = {
	phase: Phase;
	iteration: number;
	/** Short human-friendly explanation of the reviewed/changed code or behavior in this phase; not a file list. */
	summary: string;
	/**
	 * Target-oriented briefing for the final "What Was Reviewed" section.
	 * Describe the review target itself in one or two teaching-style paragraphs, not the loop phase work.
	 */
	reviewTargetBriefing?: string;
	/** Files inspected, reviewed, or touched during the phase; codeChanges is the authoritative edit ledger. */
	changedFiles: string[];
	validation: ValidationResult[];
	bucketI: BucketIItem[];
	bucketII: BucketIIItem[];
	rejectedOrKeptAsIs: RejectedItem[];
	codeChanges: CodeChange[];
	commitMessage?: CommitMessage;
	scopeBlocked?: boolean;
	validationBlocked?: boolean;
};

export type GateSnapshot = {
	phase: Phase;
	iteration: number;
	limit: number;
	reviewOnly: boolean;
	scopeBlocked: boolean;
	validationBlocked: boolean;
	checkpointUnavailable: boolean;
	bucketICandidates: number;
	acceptedBucketI: number;
	appliedBucketI: number;
	bucketII: number;
};

export type GateDecision =
	| {
			decision: "continue";
			nextPhase: Phase;
			checkpointRequired: true;
			reason: string;
	  }
	| {
			decision: "stop";
			nextPhase: "final-report";
			checkpointRequired: false;
			reason: string;
			verdict: Verdict;
	  };

export type LoopState = {
	version: 1;
	id: string;
	lifecycle: Lifecycle;
	scope: string;
	phase: Phase | "final-report";
	iteration: number;
	limit: number;
	reviewOnly: boolean;
	baseline: BaselineState;
	afterReviewCommit: AfterReviewCommitState;
	createdAt: number;
	updatedAt: number;
	/** Target-oriented briefing for the final "What Was Reviewed" section. */
	reviewTargetBriefing?: string;
	/** Union of submitted phase-scope files. Do not treat this as proof of loop edits. */
	filesChanged: string[];
	validation: ValidationResult[];
	validationCache: ValidationCacheEntry[];
	phaseCaches: PhaseEvidenceCache[];
	bucketI: BucketIItem[];
	bucketII: BucketIIItem[];
	codeChanges: CodeChange[];
	rejectedOrKeptAsIs: RejectedItem[];
	phasesRun: PhaseHistoryItem[];
	lastGate?: GateDecision;
	controlRequest?: ControlRequest;
	commitMessage?: CommitMessage;
	/** Deprecated for new entries: final reports are rendered from the ledger instead of persisted in state. */
	finalReport?: string;
	finalCleanCondition?: string;
	finalDiffInspection?: string;
	lastError?: string;
};

export type LoopEntry = {
	version: 1;
	/** Full state only for restore milestones; compact/no-op events store null to avoid repeated snapshots. */
	state: LoopState | null;
	event: string;
	at: number;
};

export const ENTRY_TYPE = "post-review-loop-state";
export const STATUS_KEY = "post-review-loop";
export const DEFAULT_LIMIT = 5;
export const MAX_SCOPE_CHARS = 16_000;
export const TOOL_NAMES = ["post_review_loop_get_state", "post_review_loop_submit_phase_result", "post_review_loop_abort"] as const;
