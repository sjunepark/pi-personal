/*
Personal Codex-style goal extension for pi.

Provenance / design references:
- OpenAI Codex `/goal` implementation, openai/codex@ebe75bb, Apache-2.0.
- Michaelliv/pi-goal@349c81e and fitchmultz/pi-codex-goal@e122be8, MIT.

This is a local implementation, not a package install. It keeps the trusted code
boundary small: no subprocesses, no network calls, no package bootstrap.
*/

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { goalSummary, parseGoalArgs, statusLine, truncate } from "./format.js";
import { goalMessageForModel } from "./prompts.js";
import { GoalRuntime, latestStateFromSession } from "./state.js";
import type { GoalEvent, GoalState, GoalTransition, UsageSnapshot } from "./types.js";
import { ENTRY_TYPE, GOAL_TOOL_NAMES, MAX_OBJECTIVE_CHARS, MESSAGE_TYPE, STATUS_KEY } from "./types.js";

type SendMessageOptions = { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };

const UPDATE_STATUS_SCHEMA = Type.Object({
	status: Type.Union([Type.Literal("complete")], {
		description: "Only complete is accepted. Do not call until the whole objective is achieved.",
	}),
});

const runtime = new GoalRuntime();

function updateStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, runtime.statusBarEnabled ? statusLine(runtime.goal) : undefined);
}

function restoreSessionGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const restored = latestStateFromSession(ctx);
	runtime.restore(restored.restoredGoal, restored.restoredStatusBar);
	updateStatus(ctx);
	syncGoalTools(pi);
}

function syncGoalTools(pi: ExtensionAPI): void {
	const activeTools = new Set(pi.getActiveTools());
	for (const toolName of GOAL_TOOL_NAMES) activeTools.delete(toolName);

	const goal = runtime.goal;
	if (!goal) {
		activeTools.add("create_goal");
		activeTools.add("get_goal");
	} else if (goal.status === "active" || goal.status === "budget_limited") {
		activeTools.add("get_goal");
		activeTools.add("update_goal");
	} else {
		activeTools.add("get_goal");
	}

	pi.setActiveTools(Array.from(activeTools));
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, event?: GoalEvent): void {
	pi.appendEntry(ENTRY_TYPE, runtime.entry(event));
	updateStatus(ctx);
	syncGoalTools(pi);
}

function commitTransition(pi: ExtensionAPI, ctx: ExtensionContext, transition: GoalTransition, options?: SendMessageOptions): void {
	persist(pi, ctx, transition.event);
	if (!transition.notifyModel) return;
	const messageGoal = transition.goal ?? transition.previousGoal;
	if (messageGoal) emitGoalMessage(pi, messageGoal, transition.event, options);
}

function emitGoalMessage(pi: ExtensionAPI, state: GoalState, event: GoalEvent, options?: SendMessageOptions): void {
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: goalMessageForModel(state, event),
			display: event !== "set" && event !== "resumed",
			details: { event, goalId: state.id, goal: state },
		},
		options,
	);
}

function queueContinuation(pi: ExtensionAPI, state: GoalState): void {
	if (!runtime.claimContinuation(state.id)) return;
	queueMicrotask(() => {
		const latest = runtime.releaseContinuation(state.id);
		if (!latest) return;
		emitGoalMessage(pi, latest, "resumed", { deliverAs: "followUp", triggerTurn: true });
	});
}

function isAbortedAgentEnd(event: { messages?: Array<{ role?: string; stopReason?: string }> }): boolean {
	return event.messages?.some((message) => message.role === "assistant" && message.stopReason === "aborted") === true;
}

function textToolResult(text: string, details?: unknown): ToolTextResult {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export default function personalGoal(pi: ExtensionAPI): void {
	pi.registerCommand("goal", {
		description: "Set, view, pause, resume, or clear a long-running goal",
		getArgumentCompletions(prefix) {
			const options = ["status", "pause", "resume", "clear", "statusbar on", "statusbar off"];
			const filtered = options.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const goal = runtime.goal;

			if (!trimmed || trimmed === "status") {
				ctx.ui.notify(goalSummary(goal), "info");
				return;
			}

			if (trimmed === "statusbar" || trimmed === "statusbar toggle" || trimmed === "statusbar on" || trimmed === "statusbar off") {
				const [, value] = trimmed.split(/\s+/, 2);
				runtime.setStatusBarEnabled(value === "on" ? true : value === "off" ? false : !runtime.statusBarEnabled);
				persist(pi, ctx);
				ctx.ui.notify(`Goal status bar ${runtime.statusBarEnabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			if (trimmed === "clear") {
				const transition = runtime.clear();
				if (!transition) {
					ctx.ui.notify("No goal is set.", "info");
					return;
				}
				commitTransition(pi, ctx, transition);
				return;
			}

			if (trimmed === "pause") {
				const transition = runtime.pause();
				if (!transition) {
					ctx.ui.notify("No active goal is set.", "warning");
					return;
				}
				commitTransition(pi, ctx, transition);
				return;
			}

			if (trimmed === "resume") {
				const transition = runtime.resume();
				if (!transition) {
					ctx.ui.notify("No paused goal is set.", "warning");
					return;
				}
				commitTransition(pi, ctx, transition, ctx.isIdle() ? { deliverAs: "followUp", triggerTurn: true } : undefined);
				return;
			}

			const parsed = parseGoalArgs(args);
			if (parsed.error) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}

			if (goal && goal.status !== "complete") {
				const ok = await ctx.ui.confirm("Replace active goal?", `Current: ${truncate(goal.objective)}\n\nNew: ${truncate(parsed.objective)}`);
				if (!ok) return;
			}

			const transition = runtime.create(parsed.objective, parsed.tokenBudget);
			commitTransition(pi, ctx, transition, { triggerTurn: ctx.isIdle(), deliverAs: "followUp" });
			ctx.ui.notify(`Goal set: ${truncate(transition.goal?.objective ?? parsed.objective)}`, "info");
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current long-running goal state for this pi session.",
		promptSnippet: "Inspect the current long-running goal, status, token budget, tokens used, and elapsed time.",
		promptGuidelines: [
			"Use get_goal when you need to inspect the current long-running user objective.",
			"When a goal is active, keep working through clear low-risk next steps instead of stopping at a plan.",
		],
		parameters: Type.Object({}),
		async execute() {
			const goal = runtime.goal;
			return textToolResult(goalSummary(goal), { goal });
		},
	});

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create a long-running goal only when the user explicitly asks for goal mode.",
		promptSnippet: "Create one active long-running goal with an objective and optional positive token budget.",
		promptGuidelines: [
			"Use create_goal only when the user explicitly asks you to start tracking a concrete long-running goal; do not infer goals from ordinary tasks.",
			"Do not create a second goal while one already exists.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Concrete objective to pursue until completion." }),
			token_budget: Type.Optional(Type.Integer({ minimum: 1, description: "Optional positive integer token budget." })),
		}),
		async execute(_toolCallId, params: { objective: string; token_budget?: number }, _signal, _onUpdate, ctx) {
			const goal = runtime.goal;
			if (goal) throw new Error("A goal already exists. Clear it before creating another goal.");
			const parsedBudget = params.token_budget === undefined ? null : params.token_budget;
			if (parsedBudget !== null && (!Number.isInteger(parsedBudget) || parsedBudget <= 0)) throw new Error("Token budget must be a positive integer.");
			const objective = params.objective.trim();
			if (!objective) throw new Error("Objective must not be empty.");
			if ([...objective].length > MAX_OBJECTIVE_CHARS) throw new Error(`Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`);
			const transition = runtime.create(objective, parsedBudget);
			commitTransition(pi, ctx, transition, { deliverAs: "followUp", triggerTurn: true });
			return textToolResult(goalSummary(transition.goal), { goal: transition.goal });
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the current goal complete only after the objective is actually achieved and no required work remains.",
		promptSnippet: "Mark the current goal complete only after an evidence-backed completion audit proves no required work remains.",
		promptGuidelines: [
			"Use update_goal with status complete only after a completion audit proves the objective is actually achieved and no required work remains.",
			"Before using update_goal, map every explicit requirement in the goal to concrete evidence from files, command output, test results, PR state, or other real artifacts; uncertainty means the goal is not complete.",
			"Do not use update_goal merely because work is stopping, substantial progress was made, tests passed without covering every requirement, or the token budget is nearly exhausted.",
		],
		parameters: UPDATE_STATUS_SCHEMA,
		async execute(_toolCallId, _params: { status: "complete" }, _signal, _onUpdate, ctx) {
			const transition = runtime.complete();
			if (!transition) throw new Error("No active or budget-limited goal is set.");
			commitTransition(pi, ctx, transition);
			return textToolResult(goalSummary(transition.goal), { goal: transition.goal });
		},
	});

	pi.on("session_start", (event, ctx) => {
		restoreSessionGoal(pi, ctx);

		const goal = runtime.goal;
		if (!goal || goal.status !== "active") return;

		if (event.reason === "reload") {
			const transition = runtime.pause();
			if (!transition?.goal) return;
			commitTransition(pi, ctx, transition);
			ctx.ui.notify(`Goal paused after reload: ${truncate(transition.goal.objective)}\nUse /goal resume to continue.`, "info");
			return;
		}

		ctx.ui.notify(`Goal restored: ${truncate(goal.objective)}\nUse /goal pause to stop continuation.`, "info");
		if (ctx.isIdle()) queueContinuation(pi, goal);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreSessionGoal(pi, ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const goal = runtime.goal;
		if (!goal || goal.status !== "active") return;
		// Persist latest visible state without changing status. Startup can resume it;
		// reload handles the safer pause path above.
		persist(pi, ctx);
	});

	pi.on("turn_start", () => {
		runtime.startTurn();
	});

	pi.on("turn_end", (event, ctx) => {
		const result = runtime.finishTurn((event.message as { usage?: UsageSnapshot } | undefined)?.usage);
		const goal = result.goal;
		if (!result.updated || !goal) return;

		if (result.transition) {
			commitTransition(pi, ctx, result.transition, { deliverAs: "followUp", triggerTurn: true });
			return;
		}

		persist(pi, ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		const goal = runtime.goal;
		if (!goal) return;

		if (goal.status === "active" && isAbortedAgentEnd(event)) {
			const transition = runtime.pause();
			if (!transition) return;
			commitTransition(pi, ctx, transition);
			ctx.ui.notify("Goal paused after interruption. Use /goal resume to continue.", "info");
			return;
		}

		const latest = runtime.goal;
		if (!latest || latest.status !== "active" || ctx.hasPendingMessages()) return;
		queueContinuation(pi, latest);
	});
}
