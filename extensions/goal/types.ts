export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type GoalEvent = "set" | "paused" | "resumed" | "cleared" | "budget_limited" | "completed";

export type UsageSnapshot = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
};

export type GoalState = {
	version: 1;
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
};

export type GoalEntry = {
	version: 1;
	goal: GoalState | null;
	statusBarEnabled: boolean;
	event?: GoalEvent;
	at: number;
};

export type GoalTransition = {
	event: GoalEvent;
	goal: GoalState | null;
	previousGoal?: GoalState;
	notifyModel: boolean;
};

export const ENTRY_TYPE = "personal-goal-state";
export const MESSAGE_TYPE = "personal-goal-message";
export const STATUS_KEY = "personal-goal";
export const MAX_OBJECTIVE_CHARS = 16_000;
export const GOAL_TOOL_NAMES = ["get_goal", "create_goal", "update_goal"] as const;
