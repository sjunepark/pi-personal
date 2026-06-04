import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import { decideNext, stopDecision } from "./gate.js";
import { countCurrentUnresolvedBucketII, currentBucketIItems, isActionableBucketI, mergeBucketIIItems } from "./ledger.js";
import { defaultAfterReviewCommit, hashText, normalizeAfterReviewCommit } from "./git.js";
import type {
	AfterReviewCommitState,
	BaselineState,
	ControlRequest,
	GateDecision,
	GateSnapshot,
	LoopEntry,
	LoopState,
	Phase,
	PhaseEvidenceCache,
	PhaseResult,
	ValidationCacheEntry,
	WorktreeFingerprint,
} from "./types.js";
import { DEFAULT_LIMIT, ENTRY_TYPE, MAX_SCOPE_CHARS } from "./types.js";

const MAX_VALIDATION_CACHE_ENTRIES = 24;
const MAX_PHASE_EVIDENCE_CACHES = 4;

function now(): number {
	return Date.now();
}

function id(): string {
	return `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeState(state: LoopState): LoopState {
	return {
		...state,
		validationCache: state.validationCache ?? [],
		phaseCaches: state.phaseCaches ?? [],
	};
}

function isLoopState(value: unknown): value is LoopState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<LoopState>;
	return state.version === 1 && typeof state.id === "string" && typeof state.scope === "string";
}

export function latestStateFromSession(ctx: ExtensionContext): LoopState | null {
	const manager = ctx.sessionManager as { getBranch?: () => unknown[]; getEntries: () => unknown[] };
	const entries = manager.getBranch?.() ?? manager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: Partial<LoopEntry> };
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		if (entry.data?.event === "cleared" || entry.data?.event === "cancelled") return null;
		if (isLoopState(entry.data?.state)) return normalizeState(clone(entry.data.state));
	}
	return null;
}

const FULL_STATE_EVENTS = new Set([
	"started",
	"phase-submitted",
	"checkpoint-completed",
	"checkpoint-skipped",
	"checkpoint-failed",
	"checkpoint-restored-paused",
	"initial-compaction-failed",
	"initial-compaction-unavailable",
	"reload-paused",
	"paused",
	"pause-requested",
	"resumed",
	"stop-requested",
	"stopped",
	"final-report-rendered",
	"final-commit-selection-requested",
	"final-commit-submitted",
	"aborted",
	"cleared",
]);

function shouldPersistFullState(event: string): boolean {
	return FULL_STATE_EVENTS.has(event);
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
	return limit;
}

function countForPhase(state: LoopState, result: PhaseResult, validationBlocked: boolean): GateSnapshot {
	const currentBucketI = currentBucketIItems([...state.bucketI, ...result.bucketI]);
	const bucketICandidates = currentBucketI.filter(isActionableBucketI).length;
	const acceptedBucketI = currentBucketI.filter((item) => item.status === "accepted" || item.status === "remaining").length;
	const appliedBucketI = result.bucketI.filter((item) => item.status === "applied").length || result.codeChanges.length;
	const bucketII = countCurrentUnresolvedBucketII([...state.bucketII, ...result.bucketII]);
	return {
		phase: result.phase,
		iteration: result.iteration,
		limit: state.limit,
		reviewOnly: state.reviewOnly,
		scopeBlocked: result.scopeBlocked === true,
		validationBlocked,
		bucketICandidates,
		acceptedBucketI,
		appliedBucketI,
		bucketII,
	};
}

function validationScopeFiles(result: PhaseResult): string[] {
	return unique([...result.changedFiles, ...result.codeChanges.flatMap((item) => item.files), ...result.bucketI.flatMap((item) => item.files)]);
}

function commandRelevantFiles(command: string, candidates: string[]): string[] {
	const normalizedCommand = command.replace(/\\/g, "/");
	const direct = candidates.filter((file) => normalizedCommand.includes(file) || normalizedCommand.includes(basename(file)));
	return direct.length ? direct : candidates;
}

function fileInputHash(files: string[], fingerprint: WorktreeFingerprint): { inputHash: string; fileHashes: Record<string, string | null> } {
	const fileHashes: Record<string, string | null> = {};
	for (const file of files.sort()) fileHashes[file] = fingerprint.fileHashes[file] ?? null;
	return { inputHash: hashText(JSON.stringify(fileHashes)), fileHashes };
}

function validationCacheEntries(cwd: string, result: PhaseResult, fingerprint: WorktreeFingerprint): ValidationCacheEntry[] {
	const candidateFiles = validationScopeFiles(result);
	return result.validation
		.filter((record) => record.result !== "skipped")
		.map((record) => {
			const relevantFiles = commandRelevantFiles(record.command, candidateFiles);
			const fileInput = relevantFiles.length ? fileInputHash(relevantFiles, fingerprint) : undefined;
			return {
				command: record.command,
				cwd,
				phase: record.phase,
				result: record.result,
				notes: record.notes,
				source: record.source ?? "fresh",
				at: now(),
				inputKind: fileInput ? "files" : "worktree",
				inputHash: fileInput?.inputHash ?? fingerprint.overallHash,
				worktreeHash: fingerprint.overallHash,
				relevantFiles,
				fileHashes: fileInput?.fileHashes,
			} satisfies ValidationCacheEntry;
		});
}

function validationInputKey(entry: ValidationCacheEntry): string {
	return [entry.cwd, entry.command, entry.inputKind, entry.inputHash].join("\u0000");
}

function hasCurrentValidationFailure(result: PhaseResult, cacheEntries: ValidationCacheEntry[]): boolean {
	if (result.validationBlocked === true) return true;
	if (cacheEntries.length) {
		const latestByInput = new Map<string, ValidationCacheEntry>();
		for (const entry of cacheEntries) latestByInput.set(validationInputKey(entry), entry);
		return Array.from(latestByInput.values()).some((entry) => entry.result === "failed");
	}

	const latestByCommand = new Map<string, PhaseResult["validation"][number]>();
	for (const record of result.validation) {
		if (record.result === "skipped") continue;
		latestByCommand.set(record.command, record);
	}
	return Array.from(latestByCommand.values()).some((record) => record.result === "failed");
}

function phaseEvidenceCache(result: PhaseResult, fingerprint: WorktreeFingerprint, gate: GateDecision): PhaseEvidenceCache {
	return {
		phase: result.phase,
		iteration: result.iteration,
		at: now(),
		summary: result.summary,
		changedFiles: unique([...result.changedFiles, ...result.codeChanges.flatMap((item) => item.files)]),
		fingerprint,
		activeBucketI: result.bucketI
			.filter((item) => item.status === "candidate" || item.status === "accepted" || item.status === "remaining")
			.map((item) => ({ title: item.title, status: item.status, fix: item.fix, files: item.files })),
		gateDecision: `${gate.decision}: ${gate.reason}`,
	};
}

function resultCompletesRequestedIteration(result: PhaseResult, gate: GateDecision, request: ControlRequest): boolean {
	return gate.decision === "continue" && result.phase === "impl" && gate.nextPhase === "post-review" && result.iteration >= request.afterIteration;
}

function controlAfterIteration(state: LoopState): number {
	return state.iteration;
}

function controlRequest(action: ControlRequest["action"], state: LoopState): ControlRequest {
	return {
		action,
		afterIteration: controlAfterIteration(state),
	};
}

export class ReviewLoopRuntime {
	#state: LoopState | null = null;

	get state(): LoopState | null {
		return this.#state ? clone(this.#state) : null;
	}

	restore(state: LoopState | null): void {
		this.#state = state ? normalizeState(clone(state)) : null;
	}

	entry(event: string): LoopEntry {
		return { version: 1, state: shouldPersistFullState(event) ? this.state : null, event, at: now() };
	}

	start(scope: string, baseline: BaselineState, options?: { limit?: number; reviewOnly?: boolean }): LoopState {
		const cleanScope = scope.trim();
		if (!cleanScope) throw new Error("scope is required");
		if ([...cleanScope].length > MAX_SCOPE_CHARS) throw new Error(`scope must be ${MAX_SCOPE_CHARS} characters or fewer`);
		const timestamp = now();
		this.#state = {
			version: 1,
			id: id(),
			lifecycle: "active",
			scope: cleanScope,
			phase: "post-review",
			iteration: 1,
			limit: normalizeLimit(options?.limit),
			reviewOnly: options?.reviewOnly === true,
			baseline,
			afterReviewCommit: defaultAfterReviewCommit(),
			createdAt: timestamp,
			updatedAt: timestamp,
			filesChanged: [],
			validation: [],
			validationCache: [],
			phaseCaches: [],
			bucketI: [],
			bucketII: [],
			codeChanges: [],
			rejectedOrKeptAsIs: [],
			phasesRun: [],
		};
		return this.state!;
	}

	pauseImmediately(): LoopState | null {
		if (!this.#state || this.#state.lifecycle !== "active") return null;
		this.#state = { ...this.#state, lifecycle: "paused", updatedAt: now() };
		return this.state;
	}

	resume(): LoopState | null {
		if (!this.#state || this.#state.lifecycle !== "paused") return null;
		this.#state = { ...this.#state, lifecycle: "active", updatedAt: now() };
		return this.state;
	}

	clear(): LoopState | null {
		const previous = this.state;
		this.#state = null;
		return previous;
	}

	requestAfterCurrentIteration(action: ControlRequest["action"]): LoopState | null {
		if (!this.#state || this.#state.lifecycle === "complete" || this.#state.lifecycle === "failed") return null;
		if (action === "pause" && this.#state.lifecycle === "paused") return this.state;
		this.#state = { ...this.#state, controlRequest: controlRequest(action, this.#state), updatedAt: now() };
		return this.state;
	}

	abort(reason: string): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		const gate: GateDecision = {
			decision: "stop",
			nextPhase: "final-report",
			phasePromptRequired: false,
			reason,
			verdict: reason.toLowerCase().includes("validation") ? "Loop stopped: validation failure remains" : "Loop stopped: scope or context needed",
		};
		this.#state = {
			...this.#state,
			lifecycle: "complete",
			phase: "final-report",
			lastGate: gate,
			controlRequest: undefined,
			lastError: reason,
			updatedAt: now(),
		};
		this.#state.afterReviewCommit = normalizeAfterReviewCommit(this.#state);
		return this.state!;
	}

	submit(result: PhaseResult, cacheInput?: { cwd: string; fingerprint: WorktreeFingerprint }): { state: LoopState; gate: GateDecision } {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		if (this.#state.lifecycle !== "active") throw new Error(`Loop is ${this.#state.lifecycle}; resume or wait before submitting a phase result.`);
		if (this.#state.phase !== result.phase) throw new Error(`Expected phase ${this.#state.phase}, got ${result.phase}.`);
		if (this.#state.iteration !== result.iteration) throw new Error(`Expected iteration ${this.#state.iteration}, got ${result.iteration}.`);

		const control = this.#state.controlRequest;
		const nextValidationCache = cacheInput ? validationCacheEntries(cacheInput.cwd, result, cacheInput.fingerprint) : [];
		const validationBlocked = hasCurrentValidationFailure(result, nextValidationCache);
		const decidedGate = decideNext(countForPhase(this.#state, result, validationBlocked));
		const gate = control?.action === "stop" && resultCompletesRequestedIteration(result, decidedGate, control) ? stopDecision("user requested stop after current iteration") : decidedGate;
		const nextIteration = gate.decision === "continue" && result.phase === "impl" && gate.nextPhase === "post-review" ? this.#state.iteration + 1 : this.#state.iteration;
		const nextPhase = gate.decision === "continue" ? gate.nextPhase : "final-report";
		const pauseAtBoundary = control?.action === "pause" && resultCompletesRequestedIteration(result, gate, control);
		const lifecycle = gate.decision === "continue" ? (pauseAtBoundary ? "paused" : "active") : "complete";
		const keepControlRequest = gate.decision === "continue" && !pauseAtBoundary ? control : undefined;
		const bucketII = mergeBucketIIItems(this.#state.bucketII, result.bucketII);
		const reviewTargetBriefing = result.reviewTargetBriefing?.trim() || this.#state.reviewTargetBriefing;
		const commitMessage = result.commitMessage?.subject.trim() ? { subject: result.commitMessage.subject.trim(), body: result.commitMessage.body?.trim() } : this.#state.commitMessage;
		const nextPhaseCache = cacheInput ? [phaseEvidenceCache(result, cacheInput.fingerprint, gate)] : [];

		this.#state = {
			...this.#state,
			lifecycle,
			phase: nextPhase,
			iteration: nextIteration,
			updatedAt: now(),
			reviewTargetBriefing,
			commitMessage,
			filesChanged: unique([...this.#state.filesChanged, ...result.changedFiles, ...result.codeChanges.flatMap((item) => item.files)]),
			validation: [...this.#state.validation, ...result.validation],
			validationCache: [...(this.#state.validationCache ?? []), ...nextValidationCache].slice(-MAX_VALIDATION_CACHE_ENTRIES),
			phaseCaches: [...(this.#state.phaseCaches ?? []), ...nextPhaseCache].slice(-MAX_PHASE_EVIDENCE_CACHES),
			bucketI: [...this.#state.bucketI, ...result.bucketI],
			bucketII,
			codeChanges: [...this.#state.codeChanges, ...result.codeChanges],
			rejectedOrKeptAsIs: [...this.#state.rejectedOrKeptAsIs, ...result.rejectedOrKeptAsIs],
			phasesRun: [
				...this.#state.phasesRun,
				{ phase: result.phase, iteration: result.iteration, gateDecision: `${gate.decision}: ${gate.reason}`, summary: result.summary },
			],
			lastGate: gate,
			controlRequest: keepControlRequest,
		};
		this.#state.afterReviewCommit = normalizeAfterReviewCommit(this.#state);
		return { state: this.state!, gate };
	}

	pauseWithError(error: string): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		this.#state = { ...this.#state, lifecycle: "paused", lastError: error, updatedAt: now() };
		return this.state!;
	}

	beginFinalCommitSelection(): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		if (this.#state.lifecycle !== "complete" || this.#state.phase !== "final-report") throw new Error(`Loop is ${this.#state.lifecycle} ${this.#state.phase}, not ready for final commit selection.`);
		this.#state = { ...this.#state, lifecycle: "finalizing", updatedAt: now() };
		return this.state!;
	}

	recordAfterReviewCommit(afterReviewCommit: AfterReviewCommitState, lastError?: string): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		this.#state = { ...this.#state, afterReviewCommit, lastError: lastError ?? this.#state.lastError, updatedAt: now() };
		return this.state!;
	}

	completeWithReport(_report: string): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		const { finalReport: _finalReport, ...stateWithoutRenderedReport } = this.#state;
		this.#state = { ...stateWithoutRenderedReport, lifecycle: "complete", phase: "final-report", controlRequest: undefined, updatedAt: now() };
		return this.state!;
	}
}
