import type { BucketIIItem, LoopState, ValidationStatus } from "../post-review-loop/types.js";
import { buildAgentCompactionRequestMessage, formatContextUsage } from "./agent-compaction-prompts.ts";

export const AUTO_DEV_ENTRY_TYPE = "auto-dev-loop-state";
export const AUTO_DEV_MESSAGE_TYPE = "auto-dev-loop";
export const AUTO_DEV_STATUS_KEY = "auto-dev-loop";
export const POST_REVIEW_LOOP_ENTRY_TYPE = "post-review-loop-state";

export const DEFAULT_TASK_FILES = ["TODO.md", "PLAN.md", "ROADMAP.md", "TASKS.md", "PLAN-*.md"];
export const DEFAULT_REVIEW_LIMIT = 5;

export type AutoDevLifecycle = "active" | "reviewing" | "awaiting_user" | "awaiting_bucket_ii" | "applying_bucket_ii" | "paused" | "complete";
export type AutoDevTaskStatus = "completed" | "needs_user" | "blocked" | "no_task";
export type AutoDevFollowupStatus = "completed" | "needs_user" | "blocked";

export type AutoDevValidation = {
	command: string;
	result: ValidationStatus;
	notes: string;
};

export type AutoDevTaskSummary = {
	title: string;
	summary: string;
	filesChanged: string[];
	validation: AutoDevValidation[];
	reviewScope?: string;
};

export type AutoDevAwaitingUser = {
	kind: "task_clarification" | "bucket_ii";
	questions: string[];
};

export type AutoDevState = {
	version: 1;
	id: string;
	lifecycle: AutoDevLifecycle;
	iteration: number;
	once: boolean;
	reviewLimit: number;
	compactBetweenTasks: boolean;
	taskFiles: string[];
	startedAt: number;
	updatedAt: number;
	lastTask?: AutoDevTaskSummary;
	pendingBucketII?: BucketIIItem[];
	postReviewLoopId?: string;
	handledPostReviewLoopId?: string;
	awaiting?: AutoDevAwaitingUser;
	lastMessage?: string;
};

export type AutoDevEntry = {
	version: 1;
	state: AutoDevState | null;
	event: string;
	at: number;
};

export type AutoDevStartOptions = {
	once?: boolean;
	reviewLimit?: number;
	compactBetweenTasks?: boolean;
	taskFiles?: string[];
};

export type AutoDevContextUsage = {
	percent: number | null;
	tokens: number | null;
	contextWindow: number;
} | undefined;

function now(): number {
	return Date.now();
}

function id(): string {
	return `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object");
}

function normalizeString(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function cleanList(values: string[] | undefined, fallback: string[]): string[] {
	const cleaned = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
	return cleaned.length ? cleaned : fallback;
}

function commandTokens(args: string): string[] {
	return args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
}

export function parseAutoDevStartArgs(args: string, defaults: AutoDevStartOptions = {}): AutoDevStartOptions {
	const tokens = commandTokens(args);
	const taskFiles: string[] = [];
	let once = defaults.once;
	let reviewLimit = defaults.reviewLimit ?? DEFAULT_REVIEW_LIMIT;
	let compactBetweenTasks = defaults.compactBetweenTasks;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--once") {
			once = true;
			continue;
		}
		if (token === "--loop") {
			once = false;
			continue;
		}
		if (token === "--compact-between-tasks") {
			compactBetweenTasks = true;
			continue;
		}
		if (token === "--no-compact-between-tasks") {
			compactBetweenTasks = false;
			continue;
		}
		if (token === "--review-limit") {
			const raw = tokens[index + 1];
			if (!raw) throw new Error("--review-limit requires a number");
			reviewLimit = Number.parseInt(raw, 10);
			index += 1;
			continue;
		}
		if (token.startsWith("--review-limit=")) {
			reviewLimit = Number.parseInt(token.slice("--review-limit=".length), 10);
			continue;
		}
		if (token === "--task-files") {
			const raw = tokens[index + 1];
			if (!raw) throw new Error("--task-files requires a comma-separated list");
			taskFiles.push(...raw.split(","));
			index += 1;
			continue;
		}
		taskFiles.push(token);
	}

	return { once, reviewLimit, compactBetweenTasks, taskFiles: cleanList(taskFiles, []) };
}

export function createAutoDevState(options: AutoDevStartOptions = {}): AutoDevState {
	const timestamp = now();
	const reviewLimit = options.reviewLimit ?? DEFAULT_REVIEW_LIMIT;
	if (!Number.isInteger(reviewLimit) || reviewLimit < 1) throw new Error("review limit must be a positive integer");
	return {
		version: 1,
		id: id(),
		lifecycle: "active",
		iteration: 1,
		once: options.once === true,
		reviewLimit,
		compactBetweenTasks: options.compactBetweenTasks !== false,
		taskFiles: cleanList(options.taskFiles, DEFAULT_TASK_FILES),
		startedAt: timestamp,
		updatedAt: timestamp,
	};
}

export function autoDevEntry(state: AutoDevState | null, event: string): AutoDevEntry {
	return { version: 1, state: state ? clone(state) : null, event, at: now() };
}

export function updateAutoDevState(state: AutoDevState, patch: Partial<Omit<AutoDevState, "version" | "id" | "startedAt">>): AutoDevState {
	return { ...state, ...patch, updatedAt: now() };
}

function isAutoDevState(value: unknown): value is AutoDevState {
	if (!isRecord(value)) return false;
	return value.version === 1 && typeof value.id === "string" && typeof value.lifecycle === "string" && typeof value.iteration === "number";
}

export function latestAutoDevStateFromEntries(entries: unknown[]): AutoDevState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: Partial<AutoDevEntry> };
		if (entry.type !== "custom" || entry.customType !== AUTO_DEV_ENTRY_TYPE) continue;
		if (entry.data?.event === "cleared") return null;
		if (isAutoDevState(entry.data?.state)) return clone(entry.data.state);
	}
	return null;
}

function isLoopState(value: unknown): value is LoopState {
	if (!isRecord(value)) return false;
	return value.version === 1 && typeof value.id === "string" && typeof value.scope === "string" && typeof value.lifecycle === "string";
}

export function latestPostReviewLoopStateFromEntries(entries: unknown[]): LoopState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: { event?: string; state?: unknown } };
		if (entry.type !== "custom" || entry.customType !== POST_REVIEW_LOOP_ENTRY_TYPE) continue;
		if (entry.data?.event === "cleared" || entry.data?.event === "cancelled") return null;
		if (isLoopState(entry.data?.state)) return clone(entry.data.state);
	}
	return null;
}

export function latestPostReviewLoopStateByIdFromEntries(entries: unknown[], loopId: string | undefined): LoopState | null {
	if (!loopId) return null;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: { event?: string; state?: unknown } };
		if (entry.type !== "custom" || entry.customType !== POST_REVIEW_LOOP_ENTRY_TYPE) continue;
		if (entry.data?.event === "cleared" || entry.data?.event === "cancelled") return null;
		if (isLoopState(entry.data?.state) && entry.data.state.id === loopId) return clone(entry.data.state);
	}
	return null;
}

function normalizedBucketIIKey(item: BucketIIItem): string {
	return item.title.trim().replace(/\s+/g, " ").toLowerCase();
}

function currentBucketIIItems(items: BucketIIItem[]): BucketIIItem[] {
	const byKey = new Map<string, BucketIIItem>();
	for (const item of items) {
		const key = normalizedBucketIIKey(item);
		if (key) byKey.set(key, item);
	}
	return Array.from(byKey.values());
}

function isUnresolvedBucketII(item: BucketIIItem): boolean {
	return item.status === "left for user decision" || item.status === "deferred" || item.status === "kept as-is for now";
}

export function unresolvedBucketIIItems(state: Pick<LoopState, "bucketII"> | null): BucketIIItem[] {
	return state ? currentBucketIIItems(state.bucketII).filter(isUnresolvedBucketII) : [];
}

function bulletList(values: string[], empty = "- none"): string {
	const cleaned = values.map(normalizeString).filter(Boolean);
	return cleaned.length ? cleaned.map((value) => `- ${value}`).join("\n") : empty;
}

function validationList(values: AutoDevValidation[]): string {
	if (!values.length) return "- none recorded";
	return values.map((item) => `- ${normalizeString(item.command)}: ${item.result} — ${normalizeString(item.notes)}`).join("\n");
}

function taskFilesText(state: AutoDevState): string {
	return state.taskFiles.map((file) => `\`${file}\``).join(", ");
}

export function reviewScopeForTask(state: AutoDevState, task: AutoDevTaskSummary): string {
	const scope = task.reviewScope?.trim();
	if (scope) return scope;
	const files = task.filesChanged.length ? ` Files changed: ${task.filesChanged.join(", ")}.` : "";
	return `auto-dev task \"${normalizeString(task.title)}\" from iteration ${state.iteration}.${files}`;
}

export function renderTaskPrompt(state: AutoDevState): string {
	return `Run auto-dev-loop iteration ${state.iteration}.

Choose and complete exactly one safe task from this project's task/plan Markdown files.

Task sources:
- Start with these candidate files/patterns: ${taskFilesText(state)}.
- Also consider nearby task/plan Markdown files you discover while inspecting the project.
- If no actionable task exists, call auto_dev_task_result with status "no_task".

Operating rules:
1. Inspect git status before editing and avoid mixing unrelated existing work into this iteration.
2. Read the relevant task/plan Markdown, then choose one high-signal task that is specific enough to complete now. Prefer explicit unchecked/Next/TODO items over vague ideas.
3. Prep before editing: read enough nearby code, docs, tests, and package scripts to understand the task. Use read-only subagents for broad independent reconnaissance when it would keep the main context lean.
4. Ask the user only for product policy, public contract, user intent, taste, missing credentials/access, destructive actions, or other project-vision decisions. Do not ask for syntax, library API details, code organization minutiae, or ordinary engineering judgment; decide those yourself.
5. If a required user decision blocks progress, stop and call auto_dev_task_result with status "needs_user" and concise questions. Do not keep coding around an unclear policy/contract.
6. Implement the task in the smallest maintainable way. Update the task/plan Markdown when the completed item is unambiguous.
7. Run the relevant existing validation when practical. If validation cannot run, record the concrete reason.
8. Do a focused design pass after implementation: remove bandages, stale compatibility paths, accidental duplication, and unclear ownership introduced by the change.
9. Finish by calling auto_dev_task_result. Do not manually start /post-review-loop; the auto-dev-loop extension will start it after a completed task.

The result tool call is required before stopping this iteration.`;
}

export function renderClarificationFollowupPrompt(state: AutoDevState, answer: string): string {
	return `The user answered the clarification request for auto-dev-loop iteration ${state.iteration}.

Previous task: ${state.lastTask ? state.lastTask.title : "not recorded"}
Previous questions:
${bulletList(state.awaiting?.questions ?? [])}

User answer:
${answer.trim()}

Continue the same task if the answer resolves the blocker. If it is still blocked, call auto_dev_task_result with status "needs_user" or "blocked" and the remaining specific questions/blocker. If you complete the task, validate it and call auto_dev_task_result with status "completed". Do not manually start /post-review-loop.`;
}

export function renderBucketIIDecisionPrompt(state: AutoDevState, items: BucketIIItem[]): string {
	return `Post-review-loop finished for auto-dev-loop iteration ${state.iteration}, but Bucket II decisions need the user's approval before more autonomous work continues.

Ask the user how to handle these Bucket II items. Keep the question concise and decision-oriented. Mention that they can answer normally or use /auto-dev bucket2 <decision>.

Bucket II items:
${items
	.map(
		(item, index) => `${index + 1}. ${normalizeString(item.title)}
   - Weakness: ${normalizeString(item.weakness)}
   - Recommended action: ${normalizeString(item.recommendedAction)}
   - Tradeoffs: ${normalizeString(item.tradeoffs)}`,
	)
	.join("\n\n")}

Do not implement these items until the user answers. Do not choose a new task.`;
}

export function renderBucketIIFollowupPrompt(state: AutoDevState, answer: string, items: BucketIIItem[]): string {
	return `The user answered the Bucket II decision request for auto-dev-loop iteration ${state.iteration}.

User answer:
${answer.trim()}

Bucket II items awaiting decision:
${items.map((item, index) => `${index + 1}. ${normalizeString(item.title)} — recommended: ${normalizeString(item.recommendedAction)}`).join("\n")}

Apply only the Bucket II follow-up work that the user clearly approved. If the answer is ambiguous, ask a focused clarification by calling auto_dev_bucket2_result with status "needs_user". If no code/docs change is requested, call auto_dev_bucket2_result with status "completed" and changesMade false. If you do make changes, validate them and call auto_dev_bucket2_result with status "completed" and changesMade true. Do not manually start /post-review-loop; the extension will start it when needed.`;
}

export function renderStatus(state: AutoDevState | null): string {
	if (!state) return "No auto-dev-loop state.";
	return [
		`auto-dev-loop: ${state.lifecycle}`,
		`iteration: ${state.iteration}${state.once ? " (once)" : ""}`,
		`task files: ${state.taskFiles.join(", ")}`,
		state.lastTask ? `last task: ${state.lastTask.title}` : undefined,
		state.pendingBucketII?.length ? `pending Bucket II: ${state.pendingBucketII.length}` : undefined,
		state.postReviewLoopId ? `post-review-loop: ${state.postReviewLoopId}` : undefined,
		state.awaiting?.questions.length ? `awaiting:\n${bulletList(state.awaiting.questions)}` : undefined,
		state.lastMessage ? `note: ${state.lastMessage}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function renderHandoffSummary(state: AutoDevState): string {
	return `Auto-dev-loop state: ${state.lifecycle}, iteration ${state.iteration}.

Task files: ${state.taskFiles.join(", ")}
Review limit: ${state.reviewLimit}
Last message: ${state.lastMessage ?? "none"}
Last task: ${state.lastTask ? state.lastTask.title : "none"}
Files changed in last task:
${bulletList(state.lastTask?.filesChanged ?? [])}
Validation:
${validationList(state.lastTask?.validation ?? [])}
Pending Bucket II decisions:
${bulletList(state.pendingBucketII?.map((item) => item.title) ?? [])}

Preserve the selected task context, user decisions, post-review-loop status, unresolved Bucket II decisions, validation evidence, and the next required auto-dev-loop action. Drop verbose raw command output and unrelated exploration.`;
}

export function renderAutoDevCompactionRequestPrompt(state: AutoDevState, usage: AutoDevContextUsage): string {
	return buildAgentCompactionRequestMessage({
		title: `Auto-dev-loop between-task context checkpoint (${formatContextUsage(usage)}).`,
		opening:
			"The previous auto-dev task, post-review-loop, and any approved Bucket II follow-up are complete. Compact before the extension asks for the next task so the next autonomous iteration starts with a small, high-signal context.",
		required: true,
		why: [
			"The between-task boundary is the safest time to replace noisy history: no implementation or review phase is currently in progress.",
			"Pi's generic compaction can lose workflow-specific facts such as the selected task, validation evidence, Bucket II decisions, and post-review-loop state.",
			"A high-fidelity agent-authored summary lets the next task start without rereading large amounts of already-inspected context.",
		],
		customInstructions: renderHandoffSummary(state),
		customInstructionsLabel: "Auto-dev-loop handoff facts to preserve",
		afterCompaction: "the auto-dev-loop extension will inject the next task prompt automatically. Do not choose or start a new task in the compaction turn.",
		failureInstruction:
			"Do not ask the human for confirmation. If you cannot produce a high-fidelity compacted context, explain the blocker instead of calling compact_conversation with a weak summary.",
	});
}
