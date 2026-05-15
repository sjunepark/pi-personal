import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { GoalEntry, GoalEvent, GoalState, GoalTransition, UsageSnapshot } from "./types.js";
import { ENTRY_TYPE } from "./types.js";

function now(): number {
	return Date.now();
}

export function cloneGoal(state: GoalState): GoalState {
	return { ...state };
}

function createGoalState(objective: string, tokenBudget: number | null): GoalState {
	const timestamp = now();
	return {
		version: 1,
		id: `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		objective,
		status: "active",
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function isGoalState(value: unknown): value is GoalState {
	if (!value || typeof value !== "object") return false;
	const state = value as GoalState;
	return (
		state.version === 1 &&
		typeof state.id === "string" &&
		typeof state.objective === "string" &&
		(state.status === "active" || state.status === "paused" || state.status === "budget_limited" || state.status === "complete") &&
		(state.tokenBudget === null || typeof state.tokenBudget === "number") &&
		typeof state.tokensUsed === "number" &&
		typeof state.timeUsedSeconds === "number" &&
		typeof state.createdAt === "number" &&
		typeof state.updatedAt === "number"
	);
}

export function latestStateFromSession(ctx: ExtensionContext): { restoredGoal: GoalState | null; restoredStatusBar: boolean } {
	const manager = ctx.sessionManager as { getBranch?: () => unknown[]; getEntries: () => unknown[] };
	const entries = manager.getBranch?.() ?? manager.getEntries();

	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: Partial<GoalEntry> };
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const data = entry.data;
		return {
			restoredGoal: isGoalState(data?.goal) ? cloneGoal(data.goal) : null,
			restoredStatusBar: data?.statusBarEnabled !== false,
		};
	}

	return { restoredGoal: null, restoredStatusBar: true };
}

export function tokenDeltaFromUsage(usage: UsageSnapshot | undefined): number {
	if (!usage) return 0;
	if (typeof usage.totalTokens === "number") return Math.max(0, Math.trunc(usage.totalTokens));
	return Math.max(
		0,
		Math.trunc(usage.input ?? 0) + Math.trunc(usage.output ?? 0) + Math.trunc(usage.cacheRead ?? 0) + Math.trunc(usage.cacheWrite ?? 0),
	);
}

export class GoalRuntime {
	#goal: GoalState | null = null;
	#statusBarEnabled = true;
	#activeTurnStartedAt: number | null = null;
	#trackedTurnGoalId: string | null = null;
	#continuationQueued = false;
	#budgetMessageSentFor: string | null = null;

	get goal(): GoalState | null {
		return this.#goal ? cloneGoal(this.#goal) : null;
	}

	get statusBarEnabled(): boolean {
		return this.#statusBarEnabled;
	}

	restore(goal: GoalState | null, statusBarEnabled: boolean): void {
		this.#goal = goal ? cloneGoal(goal) : null;
		this.#statusBarEnabled = statusBarEnabled;
		this.#activeTurnStartedAt = null;
		this.#trackedTurnGoalId = null;
		this.#continuationQueued = false;
		this.#budgetMessageSentFor = null;
	}

	entry(event?: GoalEvent): GoalEntry {
		return {
			version: 1,
			goal: this.goal,
			statusBarEnabled: this.#statusBarEnabled,
			event,
			at: now(),
		};
	}

	setStatusBarEnabled(enabled: boolean): void {
		this.#statusBarEnabled = enabled;
	}

	create(objective: string, tokenBudget: number | null): GoalTransition {
		this.#goal = createGoalState(objective, tokenBudget);
		this.#budgetMessageSentFor = null;
		return this.#transition("set");
	}

	clear(): GoalTransition | null {
		const previousGoal = this.goal;
		if (!previousGoal) return null;
		this.#goal = null;
		this.#activeTurnStartedAt = null;
		this.#trackedTurnGoalId = null;
		this.#continuationQueued = false;
		this.#budgetMessageSentFor = null;
		return { event: "cleared", goal: null, previousGoal, notifyModel: true };
	}

	pause(): GoalTransition | null {
		if (!this.#goal || this.#goal.status !== "active") return null;
		this.#goal = { ...this.#goal, status: "paused", updatedAt: now() };
		return this.#transition("paused");
	}

	resume(): GoalTransition | null {
		if (!this.#goal || this.#goal.status !== "paused") return null;
		this.#goal = { ...this.#goal, status: "active", updatedAt: now() };
		return this.#transition("resumed");
	}

	complete(): GoalTransition | null {
		if (!this.#goal || (this.#goal.status !== "active" && this.#goal.status !== "budget_limited")) return null;
		this.#goal = { ...this.#goal, status: "complete", updatedAt: now() };
		this.#continuationQueued = false;
		return this.#transition("completed");
	}

	startTurn(): void {
		this.#activeTurnStartedAt = now();
		this.#trackedTurnGoalId = this.#goal?.status === "active" ? this.#goal.id : null;
	}

	finishTurn(usage: UsageSnapshot | undefined): { goal: GoalState | null; transition?: GoalTransition; updated: boolean } {
		const trackedGoalId = this.#trackedTurnGoalId;
		this.#trackedTurnGoalId = null;
		if (!this.#goal || !trackedGoalId || this.#goal.id !== trackedGoalId || (this.#goal.status !== "active" && this.#goal.status !== "complete")) {
			this.#activeTurnStartedAt = null;
			return { goal: this.goal, updated: false };
		}

		const elapsed = this.#activeTurnStartedAt === null ? 0 : Math.max(0, Math.round((now() - this.#activeTurnStartedAt) / 1000));
		this.#activeTurnStartedAt = null;
		this.#goal = {
			...this.#goal,
			tokensUsed: this.#goal.tokensUsed + tokenDeltaFromUsage(usage),
			timeUsedSeconds: this.#goal.timeUsedSeconds + elapsed,
			updatedAt: now(),
		};

		if (this.#goal.status === "active" && this.#goal.tokenBudget !== null && this.#goal.tokensUsed >= this.#goal.tokenBudget) {
			this.#goal = { ...this.#goal, status: "budget_limited", updatedAt: now() };
			const notifyModel = this.#budgetMessageSentFor !== this.#goal.id;
			if (notifyModel) this.#budgetMessageSentFor = this.#goal.id;
			return { goal: cloneGoal(this.#goal), transition: this.#transition("budget_limited", notifyModel), updated: true };
		}

		return { goal: cloneGoal(this.#goal), updated: true };
	}

	claimContinuation(goalId: string): boolean {
		if (this.#continuationQueued || !this.#goal || this.#goal.id !== goalId || this.#goal.status !== "active") return false;
		this.#continuationQueued = true;
		return true;
	}

	releaseContinuation(goalId: string): GoalState | null {
		this.#continuationQueued = false;
		if (!this.#goal || this.#goal.id !== goalId || this.#goal.status !== "active") return null;
		return cloneGoal(this.#goal);
	}

	#transition(event: GoalEvent, notifyModel = true): GoalTransition {
		return { event, goal: this.goal, notifyModel };
	}
}
