import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { decideNext } from "./gate.js";
import { countCurrentUnresolvedBucketII, mergeBucketIIItems } from "./ledger.js";
import { defaultAfterReviewCommit, normalizeAfterReviewCommit } from "./git.js";
import type { BaselineState, GateDecision, GateSnapshot, LoopEntry, LoopState, Phase, PhaseResult } from "./types.js";
import { DEFAULT_LIMIT, ENTRY_TYPE, MAX_SCOPE_CHARS } from "./types.js";

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
		return isLoopState(entry.data?.state) ? clone(entry.data.state) : null;
	}
	return null;
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
	return limit;
}

function countForPhase(state: LoopState, result: PhaseResult): GateSnapshot {
	const bucketICandidates = result.bucketI.filter((item) => item.status === "candidate" || item.status === "remaining" || item.status === "accepted").length;
	const acceptedBucketI = result.bucketI.filter((item) => item.status === "accepted" || item.status === "remaining").length;
	const appliedBucketI = result.bucketI.filter((item) => item.status === "applied").length || result.codeChanges.length;
	const bucketII = countCurrentUnresolvedBucketII([...state.bucketII, ...result.bucketII]);
	return {
		phase: result.phase,
		iteration: result.iteration,
		limit: state.limit,
		reviewOnly: state.reviewOnly,
		scopeBlocked: result.scopeBlocked === true,
		validationBlocked: result.validationBlocked === true || result.validation.some((item) => item.result === "failed"),
		checkpointUnavailable: false,
		bucketICandidates,
		acceptedBucketI,
		appliedBucketI,
		bucketII,
	};
}

export class ReviewLoopRuntime {
	#state: LoopState | null = null;

	get state(): LoopState | null {
		return this.#state ? clone(this.#state) : null;
	}

	restore(state: LoopState | null): void {
		this.#state = state ? clone(state) : null;
	}

	entry(event: string): LoopEntry {
		return { version: 1, state: this.state, event, at: now() };
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
			bucketI: [],
			bucketII: [],
			codeChanges: [],
			rejectedOrKeptAsIs: [],
			phasesRun: [],
		};
		return this.state!;
	}

	pause(): LoopState | null {
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

	abort(reason: string): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		const gate: GateDecision = {
			decision: "stop",
			nextPhase: "final-report",
			checkpointRequired: false,
			reason,
			verdict: reason.toLowerCase().includes("validation") ? "Loop stopped: validation failure remains" : "Loop stopped: scope or context needed",
		};
		this.#state = {
			...this.#state,
			lifecycle: "complete",
			phase: "final-report",
			lastGate: gate,
			lastError: reason,
			updatedAt: now(),
		};
		this.#state.afterReviewCommit = normalizeAfterReviewCommit(this.#state);
		return this.state!;
	}

	submit(result: PhaseResult): { state: LoopState; gate: GateDecision } {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		if (this.#state.lifecycle !== "active") throw new Error(`Loop is ${this.#state.lifecycle}; resume or wait before submitting a phase result.`);
		if (this.#state.phase !== result.phase) throw new Error(`Expected phase ${this.#state.phase}, got ${result.phase}.`);
		if (this.#state.iteration !== result.iteration) throw new Error(`Expected iteration ${this.#state.iteration}, got ${result.iteration}.`);

		const gate = decideNext(countForPhase(this.#state, result));
		const nextIteration = gate.decision === "continue" && result.phase === "impl" && gate.nextPhase === "post-review" ? this.#state.iteration + 1 : this.#state.iteration;
		const nextPhase = gate.decision === "continue" ? gate.nextPhase : "final-report";
		const lifecycle = gate.decision === "continue" ? "checkpointing" : "complete";
		const bucketII = mergeBucketIIItems(this.#state.bucketII, result.bucketII);
		const reviewTargetBriefing = result.reviewTargetBriefing?.trim() || this.#state.reviewTargetBriefing;

		this.#state = {
			...this.#state,
			lifecycle,
			phase: nextPhase,
			iteration: nextIteration,
			updatedAt: now(),
			reviewTargetBriefing,
			filesChanged: unique([...this.#state.filesChanged, ...result.changedFiles, ...result.codeChanges.flatMap((item) => item.files)]),
			validation: [...this.#state.validation, ...result.validation],
			bucketI: [...this.#state.bucketI, ...result.bucketI],
			bucketII,
			codeChanges: [...this.#state.codeChanges, ...result.codeChanges],
			rejectedOrKeptAsIs: [...this.#state.rejectedOrKeptAsIs, ...result.rejectedOrKeptAsIs],
			phasesRun: [
				...this.#state.phasesRun,
				{ phase: result.phase, iteration: result.iteration, gateDecision: `${gate.decision}: ${gate.reason}`, summary: result.summary },
			],
			lastGate: gate,
		};
		this.#state.afterReviewCommit = normalizeAfterReviewCommit(this.#state);
		return { state: this.state!, gate };
	}

	markCheckpointReady(): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		if (this.#state.lifecycle !== "checkpointing") throw new Error(`Loop is ${this.#state.lifecycle}, not checkpointing.`);
		this.#state = { ...this.#state, lifecycle: "active", updatedAt: now() };
		return this.state!;
	}

	markCheckpointFailed(error: string): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		this.#state = { ...this.#state, lifecycle: "paused", lastError: error, updatedAt: now() };
		return this.state!;
	}

	completeWithReport(report: string): LoopState {
		if (!this.#state) throw new Error("No post-review-loop is active.");
		this.#state = { ...this.#state, lifecycle: "complete", phase: "final-report", finalReport: report, updatedAt: now() };
		return this.state!;
	}
}
