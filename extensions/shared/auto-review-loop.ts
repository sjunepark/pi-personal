import { DESIGN_SIGNALS, type BucketIItem, type BucketIIItem, type DesignSignal, type LoopState, type ValidationStatus } from "../post-review-loop/types.ts";
import { currentBucketIItems, currentBucketIIItems, isActionableBucketI, isUnresolvedBucketII } from "../post-review-loop/ledger.ts";

export const AUTO_REVIEW_ENTRY_TYPE = "auto-review-loop-state";
export const AUTO_REVIEW_MESSAGE_TYPE = "auto-review-loop";
export const AUTO_REVIEW_STATUS_KEY = "auto-review-loop";
export const POST_REVIEW_LOOP_ENTRY_TYPE = "post-review-loop-state";
export const AUTO_REVIEW_LEDGER_DIR = "reviews/auto-review";
export const AUTO_REVIEW_STATE_FILE = "state.json";
export const AUTO_REVIEW_LEDGER_FILE = "ledger.jsonl";
export const AUTO_REVIEW_DECISIONS_FILE = "decisions.md";

export const DEFAULT_REVIEW_LIMIT = 5;

export type AutoReviewLifecycle = "active_reviewing" | "self_reviewing" | "awaiting_user" | "paused" | "complete";
export type AutoReviewResultStatus = "clean" | "fixed" | "needs_user" | "blocked" | "no_target";
export type AutoReviewFindingTier = "auto_fix" | "ask_user" | "record_only";
export type AutoReviewFindingStatus = "found" | "fixed" | "deferred" | "kept";

export type AutoReviewValidation = {
	command: string;
	result: ValidationStatus;
	notes: string;
};

export type AutoReviewArea = {
	id: string;
	label: string;
	files: string[];
};

export type AutoReviewSlice = {
	areaId: string;
	areaLabel: string;
	files: string[];
	dimension: string;
};

export type AutoReviewFinding = {
	title: string;
	tier: AutoReviewFindingTier;
	designSignal: DesignSignal;
	summary: string;
	files: string[];
	recommendedAction: string;
	status: AutoReviewFindingStatus;
	userQuestion?: string;
};

export type AutoReviewResultSummary = {
	status: AutoReviewResultStatus;
	slice: AutoReviewSlice;
	summary: string;
	filesReviewed: string[];
	filesChanged: string[];
	validation: AutoReviewValidation[];
	findings: AutoReviewFinding[];
	questions: string[];
	blocker?: string;
};

export type AutoReviewAwaitingUser = {
	kind: "finding_decision" | "branch_decision";
	questions: string[];
	findings: AutoReviewFinding[];
};

export type AutoReviewState = {
	version: 1;
	id: string;
	lifecycle: AutoReviewLifecycle;
	iteration: number;
	once: boolean;
	reviewLimit: number;
	areas: AutoReviewArea[];
	dimensions: string[];
	completedSlices: string[];
	startedAt: number;
	updatedAt: number;
	lastSlice?: AutoReviewSlice;
	lastReview?: AutoReviewResultSummary;
	pendingFindings?: AutoReviewFinding[];
	postReviewLoopId?: string;
	handledPostReviewLoopId?: string;
	lastBranchPromptHead?: string;
	awaiting?: AutoReviewAwaitingUser;
	lastMessage?: string;
};

export type AutoReviewEntry = {
	version: 1;
	state: AutoReviewState | null;
	event: string;
	at: number;
};

export type AutoReviewStartOptions = {
	once?: boolean;
	reviewLimit?: number;
	areas?: AutoReviewArea[];
	dimensions?: string[];
};

export const DEFAULT_REVIEW_AREAS: AutoReviewArea[] = [
	{ id: "plans", label: "plan and task documents", files: ["PLAN-*.md", "TODO.md", "ROADMAP.md", "TASKS.md"] },
	{ id: "extensions", label: "Pi extension source and docs", files: ["extensions/**/*.ts", "extensions/**/*.md"] },
	{ id: "tests", label: "extension tests", files: ["tests/**/*.mjs"] },
	{ id: "package", label: "package and repository configuration", files: ["package.json", "AGENTS.md", ".gitignore"] },
];

export const DEFAULT_REVIEW_DIMENSIONS = ["correctness", "structure", "tests", "errors", "docs", "diet"];

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

function normalizeText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function cleanList(values: string[] | undefined, fallback: string[]): string[] {
	const cleaned = Array.from(new Set((values ?? []).map((value) => normalizeText(value)).filter(Boolean)));
	return cleaned.length ? cleaned : fallback;
}

function cleanArea(area: AutoReviewArea): AutoReviewArea | undefined {
	const areaId = area.id.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
	const label = normalizeText(area.label);
	const files = cleanList(area.files, []);
	if (!areaId || !label || !files.length) return undefined;
	return { id: areaId, label, files };
}

function cleanAreas(values: AutoReviewArea[] | undefined): AutoReviewArea[] {
	const source = values?.length ? values : DEFAULT_REVIEW_AREAS;
	const byId = new Map<string, AutoReviewArea>();
	for (const area of source) {
		const cleaned = cleanArea(area);
		if (cleaned) byId.set(cleaned.id, cleaned);
	}
	return byId.size ? Array.from(byId.values()) : clone(DEFAULT_REVIEW_AREAS);
}

function commandTokens(args: string): string[] {
	return args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
}

export function parseAutoReviewStartArgs(args: string, defaults: AutoReviewStartOptions = {}): AutoReviewStartOptions {
	const tokens = commandTokens(args);
	const dimensions: string[] = [];
	let once = defaults.once;
	let reviewLimit = defaults.reviewLimit ?? DEFAULT_REVIEW_LIMIT;

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
		if (token === "--review-limit" || token === "--limit") {
			const raw = tokens[index + 1];
			if (!raw) throw new Error(`${token} requires a number`);
			reviewLimit = Number.parseInt(raw, 10);
			index += 1;
			continue;
		}
		if (token.startsWith("--review-limit=")) {
			reviewLimit = Number.parseInt(token.slice("--review-limit=".length), 10);
			continue;
		}
		if (token.startsWith("--limit=")) {
			reviewLimit = Number.parseInt(token.slice("--limit=".length), 10);
			continue;
		}
		if (token === "--dimensions") {
			const raw = tokens[index + 1];
			if (!raw) throw new Error("--dimensions requires a comma-separated list");
			dimensions.push(...raw.split(","));
			index += 1;
			continue;
		}
		dimensions.push(token);
	}

	return { once, reviewLimit, dimensions: cleanList(dimensions, defaults.dimensions ?? []) };
}

export function createAutoReviewState(options: AutoReviewStartOptions = {}): AutoReviewState {
	const timestamp = now();
	const reviewLimit = options.reviewLimit ?? DEFAULT_REVIEW_LIMIT;
	if (!Number.isInteger(reviewLimit) || reviewLimit < 1) throw new Error("review limit must be a positive integer");
	return {
		version: 1,
		id: id(),
		lifecycle: "active_reviewing",
		iteration: 1,
		once: options.once === true,
		reviewLimit,
		areas: cleanAreas(options.areas),
		dimensions: cleanList(options.dimensions, DEFAULT_REVIEW_DIMENSIONS),
		completedSlices: [],
		startedAt: timestamp,
		updatedAt: timestamp,
	};
}

export function autoReviewEntry(state: AutoReviewState | null, event: string): AutoReviewEntry {
	return { version: 1, state: state ? clone(state) : null, event, at: now() };
}

export function updateAutoReviewState(state: AutoReviewState, patch: Partial<Omit<AutoReviewState, "version" | "id" | "startedAt">>): AutoReviewState {
	return { ...state, ...patch, updatedAt: now() };
}

function isAutoReviewState(value: unknown): value is AutoReviewState {
	return isRecord(value) && value.version === 1 && typeof value.id === "string" && typeof value.lifecycle === "string" && typeof value.iteration === "number";
}

export function latestAutoReviewStateFromEntries(entries: unknown[]): AutoReviewState | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: Partial<AutoReviewEntry> };
		if (entry.type !== "custom" || entry.customType !== AUTO_REVIEW_ENTRY_TYPE) continue;
		if (entry.data?.event === "cleared") return null;
		if (isAutoReviewState(entry.data?.state)) return clone(entry.data.state);
	}
	return null;
}

function isLoopState(value: unknown): value is LoopState {
	return isRecord(value) && value.version === 1 && typeof value.id === "string" && typeof value.scope === "string" && typeof value.lifecycle === "string";
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

export function reviewSliceKey(slice: AutoReviewSlice): string {
	return `${slice.areaId}:${normalizeText(slice.dimension).toLowerCase()}`;
}

export function selectNextReviewSlice(state: AutoReviewState): AutoReviewSlice | null {
	const completed = new Set(state.completedSlices);
	for (const dimension of state.dimensions) {
		for (const area of state.areas) {
			const slice: AutoReviewSlice = { areaId: area.id, areaLabel: area.label, files: area.files, dimension };
			if (!completed.has(reviewSliceKey(slice))) return slice;
		}
	}
	return null;
}

export function markReviewSliceCompleted(state: AutoReviewState, slice: AutoReviewSlice): AutoReviewState {
	const completed = new Set(state.completedSlices);
	completed.add(reviewSliceKey(slice));
	return updateAutoReviewState(state, { completedSlices: Array.from(completed), lastSlice: slice });
}

export function unresolvedBucketIIItems(state: Pick<LoopState, "bucketII"> | null): BucketIIItem[] {
	return state ? currentBucketIIItems(state.bucketII).filter(isUnresolvedBucketII) : [];
}

export function actionableBucketIItems(state: Pick<LoopState, "bucketI"> | null): BucketIItem[] {
	return state ? currentBucketIItems(state.bucketI).filter(isActionableBucketI) : [];
}

function bulletList(values: string[], empty = "- none"): string {
	const cleaned = values.map(normalizeText).filter(Boolean);
	return cleaned.length ? cleaned.map((value) => `- ${value}`).join("\n") : empty;
}

function numberedList(values: string[], empty = "1. none"): string {
	const cleaned = values.map(normalizeText).filter(Boolean);
	return cleaned.length ? cleaned.map((value, index) => `${index + 1}. ${value}`).join("\n") : empty;
}

function validationList(values: AutoReviewValidation[]): string {
	if (!values.length) return "- none recorded";
	return values.map((item) => `- ${normalizeText(item.command)}: ${item.result} — ${normalizeText(item.notes)}`).join("\n");
}

function findingsText(values: AutoReviewFinding[]): string {
	if (!values.length) return "- none";
	return values
		.map((item, index) => {
			const question = item.userQuestion ? `\n   - Question: ${normalizeText(item.userQuestion)}` : "";
			return `${index + 1}. [${item.tier}/${item.status}] ${normalizeText(item.title)}\n   - Signal: ${item.designSignal}\n   - Summary: ${normalizeText(item.summary)}\n   - Recommended: ${normalizeText(item.recommendedAction)}\n   - Files: ${item.files.length ? item.files.join(", ") : "none"}${question}`;
		})
		.join("\n");
}

function sliceText(slice: AutoReviewSlice): string {
	return `${slice.areaLabel} / ${slice.dimension} (${slice.files.join(", ")})`;
}

export function reviewScopeForResult(state: AutoReviewState, result: AutoReviewResultSummary): string {
	const files = result.filesChanged.length ? ` Files changed: ${result.filesChanged.join(", ")}.` : "";
	return `auto-review iteration ${state.iteration}: ${sliceText(result.slice)}.${files}`;
}

export function normalizeAutoReviewDesignSignal(value: string): DesignSignal {
	const cleaned = normalizeText(value);
	const signal = DESIGN_SIGNALS.find((item) => item === cleaned);
	if (!signal) throw new Error(`Invalid designSignal "${value}". Allowed: ${DESIGN_SIGNALS.map((item) => `"${item}"`).join(", ")}.`);
	return signal;
}

export function renderReviewPrompt(state: AutoReviewState, slice: AutoReviewSlice): string {
	return `Run auto-review iteration ${state.iteration}.

Review exactly one repository slice:
- Area: ${slice.areaLabel}
- Dimension: ${slice.dimension}
- Candidate files/patterns: ${slice.files.map((file) => `\`${file}\``).join(", ")}

Goal:
Find high-signal maintainability, correctness, test, error-handling, documentation, or simplification issues in this slice. Prefer real defects and root-cause design signals over speculative polish.

Operating rules:
1. Inspect git status before editing and avoid mixing unrelated existing work into this iteration.
2. Read enough real code, docs, and tests for this slice to make the review concrete. If a glob has no files, say so in the result.
3. Apply code/docs changes only for tiny obvious local fixes: typo-level docs, dead-simple guards, broken references, local test expectation fixes, or similar changes with no API/schema/contract/design debate.
4. Do not auto-fix findings involving unclear ownership, public contracts, type/schema redesign, lifecycle/concurrency, abstraction boundaries, integration contracts, or taste/product policy. Classify them as ask_user.
5. Keep record-only notes for observations that are not worth action now.
6. Run relevant existing validation when practical. If validation cannot run, record why.
7. If you changed files, stop after reporting auto_review_result with status "fixed". Do not manually start /post-review-loop; the extension will start it.
8. If user judgment is needed, call auto_review_result with status "needs_user" and concise questions.
9. If no finding needs action, call auto_review_result with status "clean".

The auto_review_result tool call is required before stopping this iteration.`;
}

export function renderFindingDecisionPrompt(state: AutoReviewState, findings: AutoReviewFinding[]): string {
	return `Auto-review iteration ${state.iteration} found items that need your decision before continuing.

Reply normally, or use /auto-review answer <decision>. A short numbered answer is fine.

Findings:
${findingsText(findings)}

Suggested reply format:
1. fix now
2. defer
3. keep as-is
4. discuss more

Do not implement these findings until the user answers. Do not choose a new review slice.`;
}

export function renderFindingFollowupPrompt(state: AutoReviewState, answer: string, findings: AutoReviewFinding[]): string {
	return `The user answered the auto-review decision request for iteration ${state.iteration}.

User answer:
${answer.trim()}

Pending findings:
${findingsText(findings)}

Apply only work that the user clearly approved. If the answer is ambiguous, call auto_review_result with status "needs_user" and the remaining specific questions. If no code/docs change is requested, call auto_review_result with status "clean" and record the decision in findings. If you do make changes, validate them and call auto_review_result with status "fixed". Do not manually start /post-review-loop; the extension will start it when needed.`;
}

export function renderGenericDecisionFollowupPrompt(state: AutoReviewState, answer: string): string {
	return `The user answered the auto-review follow-up request for iteration ${state.iteration}.

User answer:
${answer.trim()}

Pending decision context:
${bulletList(state.awaiting?.questions ?? [])}

Apply only clearly approved follow-up work. If this is a branch-sync answer, do not merge or rebase unless the user explicitly approved it. If you change files, validate them and call auto_review_result with status "fixed". If no change is needed, call auto_review_result with status "clean". If the answer is ambiguous, call auto_review_result with status "needs_user".`;
}

export function renderPostReviewDecisionPrompt(state: AutoReviewState, bucketI: BucketIItem[], bucketII: BucketIIItem[]): string {
	const bucketILines = bucketI.map((item) => `${item.title} — ${item.fix}`);
	const bucketIILines = bucketII.map((item) => `${item.title} — ${item.recommendedAction}`);
	return `Post-review-loop finished for auto-review iteration ${state.iteration}, but follow-up decisions remain before autonomous review continues.

Reply normally, or use /auto-review answer <decision>. A short numbered answer is fine.

Actionable Bucket I items from self-review:
${numberedList(bucketILines, "- none")}

Bucket II decision items from self-review:
${numberedList(bucketIILines, "- none")}

Options:
1. approve safe fixes
2. defer
3. keep as-is
4. discuss more

Do not choose a new review slice until the user answers.`;
}

export function renderStatus(state: AutoReviewState | null): string {
	if (!state) return "No auto-review-loop state.";
	return [
		`auto-review-loop: ${state.lifecycle}`,
		`iteration: ${state.iteration}${state.once ? " (once)" : ""}`,
		`review limit: ${state.reviewLimit}`,
		state.lastSlice ? `last slice: ${sliceText(state.lastSlice)}` : undefined,
		state.completedSlices.length ? `completed slices: ${state.completedSlices.length}` : undefined,
		state.pendingFindings?.length ? `pending findings: ${state.pendingFindings.length}` : undefined,
		state.postReviewLoopId ? `post-review-loop: ${state.postReviewLoopId}` : undefined,
		state.awaiting?.questions.length ? `awaiting:\n${bulletList(state.awaiting.questions)}` : undefined,
		state.lastMessage ? `note: ${state.lastMessage}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function renderLedgerState(state: AutoReviewState): Record<string, unknown> {
	return {
		version: state.version,
		id: state.id,
		lifecycle: state.lifecycle,
		iteration: state.iteration,
		once: state.once,
		reviewLimit: state.reviewLimit,
		areas: state.areas,
		dimensions: state.dimensions,
		completedSlices: state.completedSlices,
		lastSlice: state.lastSlice,
		lastReview: state.lastReview
			? {
					status: state.lastReview.status,
					summary: state.lastReview.summary,
					filesReviewed: state.lastReview.filesReviewed,
					filesChanged: state.lastReview.filesChanged,
					findings: state.lastReview.findings,
					validation: state.lastReview.validation,
				}
			: undefined,
		pendingFindings: state.pendingFindings,
		postReviewLoopId: state.postReviewLoopId,
		handledPostReviewLoopId: state.handledPostReviewLoopId,
		lastBranchPromptHead: state.lastBranchPromptHead,
		lastMessage: state.lastMessage,
		updatedAt: state.updatedAt,
	};
}
