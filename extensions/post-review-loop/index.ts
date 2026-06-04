import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { agentCompaction } from "../agent-compaction.js";
import { computeWorktreeFingerprint, createAfterReviewCommit, establishBaseline, failedAfterReviewCommit, needsAgentSelectedAfterReviewCommit } from "./git.js";
import { currentBucketIItems, currentBucketIIItems } from "./ledger.js";
import { finalCommitPrompt, oneshotPrompt, phasePrompt, renderReusableEvidenceForStatus, resumePrompt } from "./prompts.js";
import { renderCurrentReport, renderFinalReport } from "./report.js";
import { latestStateFromSession, ReviewLoopRuntime } from "./state.js";
import type { AfterReviewCommitState, BucketIStatus, BucketIIStatus, ControlRequest, DesignSignal, LoopState, PhaseResult, ValidationResult, WorktreeFingerprint } from "./types.js";
import { DESIGN_SIGNALS, ENTRY_TYPE, STATUS_KEY } from "./types.js";

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean; terminate?: boolean };
type MarkdownConstructor = new (text: string, paddingX: number, paddingY: number, theme: unknown) => unknown;
type RuntimeDeps = { Markdown: MarkdownConstructor; getMarkdownTheme: () => unknown };
type PendingMarkdownMessage = { title: string; markdown: string };

const runtime = new ReviewLoopRuntime();
let runtimeDeps: RuntimeDeps | undefined;
const pendingMarkdownMessages: PendingMarkdownMessage[] = [];
let agentActive = false;
let pendingPhasePrompt: LoopState | null = null;
let scheduledPhasePrompt: ReturnType<typeof setTimeout> | null = null;
let phasePromptScheduleVersion = 0;
const MARKDOWN_MESSAGE_TYPE = "post-review-loop-markdown";
const DEFAULT_REVIEW_SCOPE = "uncommitted changes";
const COMPACT_STATUS_ITEM_LIMIT = 8;

const PhaseSchema = Type.Union([Type.Literal("post-review"), Type.Literal("impl-review"), Type.Literal("impl")]);
const ValidationStatusSchema = Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]);
const ValidationSourceSchema = Type.Union([Type.Literal("fresh"), Type.Literal("reused")]);
const BucketIStatusSchema = Type.String({
	description: 'Allowed: "candidate", "accepted", "applied", "rejected", "remaining", "downgraded".',
});
const BucketIIStatusSchema = Type.String({
	description: 'Allowed: "left for user decision", "deferred", "kept as-is for now", "implemented after explicit approval". Common aliases like "open" are normalized.',
});
const DESIGN_SIGNAL_DESCRIPTION = `Root-cause/design-smell class. Allowed: ${DESIGN_SIGNALS.map((signal) => `"${signal}"`).join(", ")}.`;
const DesignSignalSchema = Type.String({ description: DESIGN_SIGNAL_DESCRIPTION });

const ValidationSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	result: ValidationStatusSchema,
	phase: Type.Union([PhaseSchema, Type.Literal("final-report")]),
	notes: Type.String({ minLength: 1 }),
	source: Type.Optional(ValidationSourceSchema),
});

const BucketISchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	revealed: Type.String({ minLength: 1 }),
	designSignal: DesignSignalSchema,
	status: BucketIStatusSchema,
	fix: Type.String({ minLength: 1 }),
	files: Type.Array(Type.String()),
	bandageReason: Type.String({ minLength: 1 }),
	validation: Type.Array(Type.String()),
});

const BucketIISchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	revealed: Type.String({ minLength: 1 }),
	designSignal: DesignSignalSchema,
	weakness: Type.String({ minLength: 1 }),
	options: Type.Array(Type.String()),
	recommendedAction: Type.String({ minLength: 1 }),
	tradeoffs: Type.String({ minLength: 1 }),
	status: BucketIIStatusSchema,
});

const RejectedSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	reason: Type.String({ minLength: 1 }),
});

const CodeChangeSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	files: Type.Array(Type.String()),
	issueAddressed: Type.String({ minLength: 1 }),
	scopeReason: Type.String({ minLength: 1 }),
	validation: Type.Array(Type.String()),
	inspect: Type.String({ minLength: 1 }),
});

const CommitMessageSchema = Type.Object({
	subject: Type.String({
		minLength: 1,
		description: "Ordinary project commit subject for the finalized reviewed work. Do not mention post-review-loop, checkpointing, or automation.",
	}),
	body: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Optional concise commit body describing the user-facing/code change and validation. Do not include loop ids or extension metadata.",
		}),
	),
});

const SubmitPhaseResultSchema = Type.Object({
	phase: PhaseSchema,
	iteration: Type.Integer({ minimum: 1 }),
	summary: Type.String({
		minLength: 1,
		description: "Short human-friendly explanation of what was reviewed or changed in this phase; not a file list or bucket list.",
	}),
	reviewTargetBriefing: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"One or two teaching-style paragraphs for the final What Was Reviewed section. Explain the review target itself, such as the uncommitted changes or named feature/refactor, not phase activity.",
		}),
	),
	changedFiles: Type.Array(Type.String(), { description: "Files inspected, reviewed, or touched in this phase; not proof that the loop edited them." }),
	validation: Type.Array(ValidationSchema),
	bucketI: Type.Array(BucketISchema),
	bucketII: Type.Array(BucketIISchema),
	rejectedOrKeptAsIs: Type.Array(RejectedSchema),
	codeChanges: Type.Array(CodeChangeSchema, { description: "Authoritative list of code edits applied by the loop; keep empty for review-only phases." }),
	commitMessage: Type.Optional(CommitMessageSchema),
	scopeBlocked: Type.Optional(Type.Boolean()),
	validationBlocked: Type.Optional(Type.Boolean()),
});

const FinalCommitResultSchema = Type.Object({
	committed: Type.Boolean({ description: "True when an after-review commit was created or an existing commit already contains the loop-applied edits." }),
	ref: Type.Optional(Type.String({ minLength: 1, description: "Commit ref when committed is true, preferably git rev-parse --short HEAD." })),
	files: Type.Array(Type.String(), { description: "Files included in the selected after-review commit or verified as already committed." }),
	notes: Type.String({ minLength: 1, description: "What was committed, skipped, or left uncommitted, including any unrelated hunks intentionally left out." }),
});

const AbortSchema = Type.Object({
	reason: Type.String({ minLength: 1 }),
});

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function textToolResult(text: string, details?: unknown, isError = false, terminate = false): ToolTextResult {
	return { content: [{ type: "text", text }], details, isError, terminate };
}

function loadRuntimeDeps(): RuntimeDeps {
	const runtimeEntry = getRuntimeRequireTarget();
	const requireFromRuntime = createRequire(runtimeEntry);
	const runtimeDir = dirname(runtimeEntry);
	const pi = requireFirst(requireFromRuntime, [join(runtimeDir, "index.js"), join(dirname(runtimeDir), "index.js")]);
	const tui = requireFirst(requireFromRuntime, ["@mariozechner/pi-tui", "@earendil-works/pi-tui"]);
	return { Markdown: tui.Markdown as MarkdownConstructor, getMarkdownTheme: pi.getMarkdownTheme as () => unknown };
}

function requireFirst(requireFromRuntime: (id: string) => any, candidates: string[]): any {
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return requireFromRuntime(candidate);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

function getRuntimeRequireTarget(): string {
	const runtimeEntry = process.argv[1];
	if (runtimeEntry?.includes("/")) {
		try {
			return realpathSync(runtimeEntry);
		} catch {
			return runtimeEntry;
		}
	}
	return fileURLToPath(import.meta.url);
}

function getRuntimeDeps(): RuntimeDeps {
	runtimeDeps ??= loadRuntimeDeps();
	return runtimeDeps;
}

function markdownComponent(markdown: string): any {
	const deps = getRuntimeDeps();
	return new deps.Markdown(markdown, 1, 1, deps.getMarkdownTheme());
}

function sendMarkdownMessage(
	pi: ExtensionAPI,
	title: string,
	markdown: string,
	options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean },
): void {
	pi.sendMessage(
		{
			customType: MARKDOWN_MESSAGE_TYPE,
			content: markdown,
			display: true,
			details: { title, markdown },
		},
		options,
	);
}

function queueMarkdownMessageAfterAgent(title: string, markdown: string): void {
	pendingMarkdownMessages.push({ title, markdown });
}

function showMarkdownMessage(pi: ExtensionAPI, ctx: ExtensionContext, title: string, markdown: string): void {
	if (agentActive) {
		queueMarkdownMessageAfterAgent(title, markdown);
		return;
	}
	if (!ctx.isIdle()) {
		sendMarkdownMessageWhenIdle(pi, ctx, { title, markdown });
		return;
	}
	sendMarkdownMessage(pi, title, markdown);
}

function sendMarkdownMessageWhenIdle(pi: ExtensionAPI, ctx: ExtensionContext, message: PendingMarkdownMessage): void {
	setTimeout(() => {
		if (!ctx.isIdle()) {
			sendMarkdownMessageWhenIdle(pi, ctx, message);
			return;
		}
		sendMarkdownMessage(pi, message.title, message.markdown);
	}, 25);
}

function flushQueuedMarkdownMessagesAfterAgent(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const messages = pendingMarkdownMessages.splice(0);
	if (!messages.length) return;
	for (const message of messages) sendMarkdownMessageWhenIdle(pi, ctx, message);
}

function clearScheduledPhasePrompt(): void {
	phasePromptScheduleVersion += 1;
	if (!scheduledPhasePrompt) return;
	clearTimeout(scheduledPhasePrompt);
	scheduledPhasePrompt = null;
}

function sendPhasePromptWhenIdle(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState): void {
	clearScheduledPhasePrompt();
	const version = phasePromptScheduleVersion;
	const poll = () => {
		if (version !== phasePromptScheduleVersion) return;
		if (!ctx.isIdle()) {
			scheduledPhasePrompt = setTimeout(poll, 25);
			return;
		}
		scheduledPhasePrompt = null;
		sendPhasePrompt(pi, ctx, state);
	};
	scheduledPhasePrompt = setTimeout(poll, 25);
}

function queuePhasePromptAfterAgent(state: LoopState): void {
	pendingPhasePrompt = state;
}

function flushQueuedPhasePromptAfterAgent(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const state = pendingPhasePrompt;
	pendingPhasePrompt = null;
	if (!state || state.lifecycle !== "active" || state.phase === "final-report") return;
	sendPhasePromptWhenIdle(pi, ctx, state);
}

function compactText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function compactStatusText(value: string, maxChars = 220): string {
	const cleaned = compactText(value);
	if (cleaned.length <= maxChars) return cleaned;
	return `${cleaned.slice(0, maxChars).trimEnd()}… [truncated ${cleaned.length - maxChars} chars]`;
}

function compactStatusItems<T>(items: T[], render: (item: T) => string, limit = COMPACT_STATUS_ITEM_LIMIT): string {
	if (!items.length) return "- none";
	const shown = items.slice(0, limit).map(render);
	const hidden = items.length - shown.length;
	return [...shown, hidden > 0 ? `- ${hidden} more item(s) remain queued; use full status/report for details.` : undefined].filter((item): item is string => Boolean(item)).join("\n");
}

function compactStatusArray(values: string[], limit = COMPACT_STATUS_ITEM_LIMIT): string[] {
	const shown = values.slice(0, limit).map((value) => compactStatusText(value));
	const hidden = values.length - shown.length;
	return hidden > 0 ? [...shown, `${hidden} more item(s) remain queued; use full status/report for details.`] : shown;
}

function controlRequestText(request: ControlRequest | undefined): string | undefined {
	if (!request) return undefined;
	return `${request.action} after iteration ${request.afterIteration}`;
}

function currentFailedValidation(state: LoopState): ValidationResult[] {
	if (state.validationCache?.length) {
		const latestByCommand = new Map<string, LoopState["validationCache"][number]>();
		for (const entry of state.validationCache) latestByCommand.set(entry.command, entry);
		return Array.from(latestByCommand.values())
			.filter((entry) => entry.result === "failed")
			.map((entry) => ({ command: entry.command, result: entry.result, phase: entry.phase, notes: entry.notes, source: entry.source }));
	}

	const latestByCommand = new Map<string, ValidationResult>();
	for (const record of state.validation) {
		if (record.result === "skipped") continue;
		latestByCommand.set(record.command, record);
	}
	return Array.from(latestByCommand.values()).filter((record) => record.result === "failed");
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function fingerprintFiles(state: LoopState): string[] {
	return unique([
		...state.baseline.scopedFiles,
		...state.filesChanged,
		...state.codeChanges.flatMap((item) => item.files),
		...state.bucketI.flatMap((item) => item.files),
	]);
}

function currentFingerprintForState(ctx: ExtensionContext, state: LoopState | null): WorktreeFingerprint | undefined {
	if (!state) return undefined;
	try {
		return computeWorktreeFingerprint(ctx.cwd, fingerprintFiles(state));
	} catch {
		return undefined;
	}
}

function statusText(state: LoopState | null): string {
	if (!state) return "No post-review-loop state.";
	return compactStatusMarkdown(state);
}

function compactStatusMarkdown(state: LoopState | null, options: { currentFingerprint?: WorktreeFingerprint } = {}): string {
	if (!state) return "No post-review-loop state.";
	const currentBucketI = currentBucketIItems(state.bucketI);
	const actionableBucketI = currentBucketI.filter((item) => item.status === "candidate" || item.status === "accepted" || item.status === "remaining");
	const currentBucketII = currentBucketIIItems(state.bucketII);
	const unresolvedBucketII = currentBucketII.filter((item) => item.status === "left for user decision" || item.status === "deferred" || item.status === "kept as-is for now");
	const failedValidation = currentFailedValidation(state).slice(-3);
	return [
		"# Post-Review Loop Status",
		"",
		`- Lifecycle: ${state.lifecycle}`,
		`- Phase: ${state.phase}`,
		`- Iteration: ${state.iteration}/${state.limit}`,
		`- Scope: ${compactStatusText(state.scope, 600)}`,
		`- Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${compactStatusText(state.lastGate.reason, 260)}` : "none"}`,
		state.controlRequest ? `- Pending request: ${controlRequestText(state.controlRequest)}` : undefined,
		agentCompaction.busy ? "- Agent compaction: pending" : undefined,
		state.lastError ? `- Last error: ${compactStatusText(state.lastError, 260)}` : undefined,
		"",
		"## Required Next Action",
		"",
		requiredNextAction(state),
		"",
		"## Actionable Bucket I",
		"",
		compactStatusItems(actionableBucketI, (item) => `- [${item.status}] ${compactStatusText(item.title)}`),
		"",
		"## Unresolved Bucket II",
		"",
		compactStatusItems(unresolvedBucketII, (item) => `- [${item.status}] ${compactStatusText(item.title)}`),
		"",
		"## Recent Failed Validation",
		"",
		compactStatusItems(failedValidation, (item) => `- ${compactStatusText(item.command)} — ${compactStatusText(item.notes, 260)}`, 3),
		"",
		"## Reusable Evidence",
		"",
		renderReusableEvidenceForStatus(state, options.currentFingerprint),
	]
		.filter((part): part is string => Boolean(part))
		.join("\n");
}

function fullStatusMarkdown(state: LoopState | null): string {
	if (!state) return "No post-review-loop state.";
	if (state.lifecycle === "complete") return renderFinalReport(state, { full: true });
	return renderCurrentReport(state, { full: true });
}

function statusMarkdown(state: LoopState | null, options: { full?: boolean; currentFingerprint?: WorktreeFingerprint } = {}): string {
	return options.full ? fullStatusMarkdown(state) : compactStatusMarkdown(state, options);
}

function requiredNextAction(state: LoopState): string {
	if (agentCompaction.busy) return "Wait for the pending agent-facing compaction to finish; do not submit a phase result yet.";
	const control = controlRequestText(state.controlRequest);
	if (state.lifecycle === "complete") return "No further post-review-loop action is required. The final report has been rendered or is available from post_review_loop_get_state and /post-review-loop report.";
	if (state.lifecycle === "finalizing") return "Create or verify the selective after-review commit for loop-applied edits, then call post_review_loop_submit_final_commit_result.";
	if (state.lifecycle === "paused") return "Resume the loop before submitting another phase result.";
	if (state.phase === "final-report") return "Render or inspect the final report.";
	return `Complete ${state.phase} iteration ${state.iteration}, then call post_review_loop_submit_phase_result.${control ? ` Pending request: ${control}.` : ""}`;
}

function compactToolDetails(state: LoopState | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
	if (!state) return { state: null, agentCompactionPending: agentCompaction.busy, ...extra };
	const currentBucketI = currentBucketIItems(state.bucketI);
	const currentBucketII = currentBucketIIItems(state.bucketII);
	return {
		state: {
			id: state.id,
			lifecycle: state.lifecycle,
			phase: state.phase,
			iteration: state.iteration,
			limit: state.limit,
			lastGate: state.lastGate ? { decision: state.lastGate.decision, reason: compactStatusText(state.lastGate.reason, 260) } : undefined,
			controlRequest: state.controlRequest,
			actionableBucketI: compactStatusArray(currentBucketI.filter((item) => item.status === "candidate" || item.status === "accepted" || item.status === "remaining").map((item) => item.title)),
			unresolvedBucketII: compactStatusArray(
				currentBucketII.filter((item) => item.status === "left for user decision" || item.status === "deferred" || item.status === "kept as-is for now").map((item) => item.title),
			),
			failedValidation: currentFailedValidation(state)
				.slice(-3)
				.map((item) => ({ ...item, command: compactStatusText(item.command), notes: compactStatusText(item.notes, 260) })),
			requiredNextAction: requiredNextAction(state),
		},
		agentCompactionPending: agentCompaction.busy,
		...extra,
	};
}

function statusBar(state: LoopState | null): string | undefined {
	if (!state || state.lifecycle === "complete") return undefined;
	return `post-review-loop: ${state.lifecycle} ${state.phase} ${state.iteration}/${state.limit}`;
}

function updateStatus(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusBar(runtime.state));
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, event: string): void {
	pi.appendEntry(ENTRY_TYPE, runtime.entry(event));
	updateStatus(ctx);
}

function commandTokens(args: string): string[] {
	return args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
}

function parseStartArgs(args: string): { scope: string; limit?: number; reviewOnly: boolean; gitCheckpoint: boolean } {
	const tokens = commandTokens(args);
	let limit: number | undefined;
	let reviewOnly = false;
	let gitCheckpoint = true;
	const scopeParts: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--review-only") {
			reviewOnly = true;
			continue;
		}
		if (token === "--no-git-checkpoint") {
			gitCheckpoint = false;
			continue;
		}
		if (token === "--git-checkpoint") {
			gitCheckpoint = true;
			continue;
		}
		if (token === "--limit") {
			const raw = tokens[index + 1];
			if (!raw) throw new Error("--limit requires a number");
			limit = Number.parseInt(raw, 10);
			index += 1;
			continue;
		}
		if (token.startsWith("--limit=")) {
			limit = Number.parseInt(token.slice("--limit=".length), 10);
			continue;
		}
		scopeParts.push(token);
	}
	return { scope: scopeParts.join(" ").trim(), limit, reviewOnly, gitCheckpoint };
}

function parseOneshotArgs(args: string): { scope: string; reviewOnly: boolean } {
	const tokens = commandTokens(args);
	let reviewOnly = false;
	const scopeParts: string[] = [];
	for (const token of tokens) {
		if (token === "--review-only") {
			reviewOnly = true;
			continue;
		}
		scopeParts.push(token);
	}
	return { scope: scopeParts.join(" ").trim(), reviewOnly };
}

function renderReportOnly(options: { full?: boolean } = {}): string {
	const state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	return state.lifecycle === "complete" ? renderFinalReport(state, options) : renderCurrentReport(state, options);
}

function cancelLoop(pi: ExtensionAPI, ctx: ExtensionContext): { hadState: boolean; hadPendingPrompt: boolean; hadPendingCompaction: boolean; abortedAgent: boolean } {
	const hadPendingPrompt = pendingPhasePrompt !== null;
	const hadPendingCompaction = agentCompaction.pendingSource?.startsWith("post-review-loop:") === true;
	const previous = runtime.clear();
	const hadState = Boolean(previous);
	if (!hadState && !hadPendingPrompt && !hadPendingCompaction) return { hadState, hadPendingPrompt, hadPendingCompaction, abortedAgent: false };

	pendingPhasePrompt = null;
	clearScheduledPhasePrompt();
	if (hadPendingCompaction) agentCompaction.clearSource("post-review-loop:");
	pendingMarkdownMessages.splice(0);
	persist(pi, ctx, "cancelled");
	return { hadState, hadPendingPrompt, hadPendingCompaction, abortedAgent: !ctx.isIdle() };
}

const BUCKET_I_STATUSES: BucketIStatus[] = ["candidate", "accepted", "applied", "rejected", "remaining", "downgraded"];
const BUCKET_II_STATUSES: BucketIIStatus[] = ["left for user decision", "deferred", "kept as-is for now", "implemented after explicit approval"];
const BUCKET_I_STATUS_BY_KEY = new Map<string, BucketIStatus>(BUCKET_I_STATUSES.map((status): [string, BucketIStatus] => [status, status]));
const BUCKET_II_STATUS_BY_KEY = new Map<string, BucketIIStatus>(BUCKET_II_STATUSES.map((status): [string, BucketIIStatus] => [status, status]));
const DESIGN_SIGNAL_BY_KEY = new Map<string, DesignSignal>(DESIGN_SIGNALS.map((signal): [string, DesignSignal] => [signal, signal]));
const BUCKET_II_STATUS_ALIASES: Record<string, BucketIIStatus> = {
	open: "left for user decision",
	unresolved: "left for user decision",
	pending: "left for user decision",
	"needs decision": "left for user decision",
	"needs user decision": "left for user decision",
	kept: "kept as-is for now",
	"kept as-is": "kept as-is for now",
	implemented: "implemented after explicit approval",
};

function normalizeBucketIIStatus(value: string): BucketIIStatus {
	const cleanValue = compactText(value).toLowerCase();
	const aliased = BUCKET_II_STATUS_ALIASES[cleanValue];
	if (aliased) return aliased;
	const canonical = BUCKET_II_STATUS_BY_KEY.get(cleanValue);
	if (canonical) return canonical;
	throw new Error(
		`Invalid Bucket II status "${value}". Allowed: "left for user decision", "deferred", "kept as-is for now", "implemented after explicit approval".`,
	);
}

function normalizeBucketIStatus(value: string): BucketIStatus {
	const canonical = BUCKET_I_STATUS_BY_KEY.get(compactText(value).toLowerCase());
	if (canonical) return canonical;
	throw new Error(`Invalid Bucket I status "${value}". Allowed: "candidate", "accepted", "applied", "rejected", "remaining", "downgraded".`);
}

function normalizeValidationSource(value: unknown): "fresh" | "reused" | undefined {
	if (value === undefined) return undefined;
	const cleanValue = compactText(String(value)).toLowerCase();
	if (cleanValue === "fresh" || cleanValue === "reused") return cleanValue;
	throw new Error(`Invalid validation source "${String(value)}". Allowed: "fresh", "reused".`);
}

function normalizeDesignSignal(value: string): DesignSignal {
	const canonical = DESIGN_SIGNAL_BY_KEY.get(compactText(value).toLowerCase());
	if (canonical) return canonical;
	throw new Error(`Invalid designSignal "${value}". Allowed: ${DESIGN_SIGNALS.map((signal) => `"${signal}"`).join(", ")}.`);
}

function normalizePhaseResult(params: PhaseResult): PhaseResult {
	return {
		...params,
		validation: params.validation.map((item) => ({ ...item, source: normalizeValidationSource(item.source) })),
		bucketI: params.bucketI.map((item) => ({ ...item, designSignal: normalizeDesignSignal(String(item.designSignal)), status: normalizeBucketIStatus(String(item.status)) })),
		bucketII: params.bucketII.map((item) => ({ ...item, designSignal: normalizeDesignSignal(String(item.designSignal)), status: normalizeBucketIIStatus(String(item.status)) })),
	};
}

function registerMarkdownRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(MARKDOWN_MESSAGE_TYPE, (message) => {
		const details = message.details as { markdown?: string } | undefined;
		const fallback = typeof message.content === "string" ? message.content : "";
		return markdownComponent(details?.markdown ?? fallback);
	});
}

function completeWithReport(pi: ExtensionAPI, ctx: ExtensionContext, event: string, options: { skipCommit?: boolean } = {}): string {
	let state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	if (!options.skipCommit) {
		try {
			runtime.recordAfterReviewCommit(createAfterReviewCommit(ctx.cwd, state));
		} catch (error) {
			runtime.recordAfterReviewCommit(failedAfterReviewCommit(ctx.cwd, state, error), error instanceof Error ? error.message : String(error));
		}
	}
	state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	const report = renderFinalReport(state);
	runtime.completeWithReport(report);
	persist(pi, ctx, event);
	return report;
}

function startFinalCommitSelection(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const finalizing = runtime.beginFinalCommitSelection();
	persist(pi, ctx, "final-commit-selection-requested");
	pi.sendUserMessage(finalCommitPrompt(finalizing), { deliverAs: "followUp" });
}

function startLoop(pi: ExtensionAPI, ctx: ExtensionContext, scope: string, options: { limit?: number; reviewOnly: boolean; gitCheckpoint: boolean }): LoopState {
	const baseline = establishBaseline(ctx.cwd, scope, { checkpoint: options.gitCheckpoint });
	const state = runtime.start(baseline.reviewScope ?? scope, baseline, options);
	persist(pi, ctx, "started");
	return state;
}

function sendPhasePrompt(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState): void {
	if (state.phase === "final-report") return;
	pi.sendUserMessage(phasePrompt(state, state.phase, { currentFingerprint: currentFingerprintForState(ctx, state) }), { deliverAs: "followUp" });
}

function initialCompactionRequestMessage(kind: "start" | "oneshot", scope: string, nextAction: string): string {
	return `Post-review-loop initial context compaction required before ${kind}.

This is an agent-facing workflow kickoff, not a request for the human user. Before any review work, call compact_conversation with a high-fidelity compacted working context, then stop this turn.

Why this is required:
- The post-review-loop is a multi-step workflow, so it should start from a small high-signal context.
- The loop no longer compacts after each phase; mid-iteration pressure is handled later by context-compaction-guard threshold checkpoints.
- Starting with an agent-authored summary avoids relying on pi's generic compaction summary for workflow state.

Your compact_conversation summary should preserve:
## Current task
- User requested /post-review-loop ${kind}.
- Scope: ${compactStatusText(scope, 1200)}
- After compaction: ${nextAction}
## User constraints and preferences
## Current repository/session state needed to continue
## Files and code already inspected, with relevant snippets when needed
## Files modified / pending edits
## Commands and validation results
## Errors, blockers, and open questions
## Next actions

Do not inspect new files or start the review before compacting. If compaction fails, do not continue implicitly; the extension will pause instead.`;
}

function requestInitialLoopCompaction(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState): void {
	const ok = agentCompaction.request(pi, ctx, {
		source: "post-review-loop:start",
		message: initialCompactionRequestMessage("start", state.scope, "the extension will inject the first authoritative phase prompt"),
		details: { loopId: state.id, phase: state.phase, iteration: state.iteration },
		onComplete: () => {
			const current = runtime.state;
			if (!current || current.id !== state.id || current.lifecycle !== "active") return;
			sendPhasePrompt(pi, ctx, current);
		},
		onError: (_pi, _ctx, error) => {
			const current = runtime.state;
			if (!current || current.id !== state.id) return;
			runtime.pauseImmediately();
			persist(pi, ctx, "initial-compaction-failed");
			notify(ctx, `Post-review-loop paused because initial compaction failed: ${error.message}. Use /post-review-loop resume to continue explicitly.`, "error");
		},
	});
	if (ok) return;
	runtime.pauseImmediately();
	persist(pi, ctx, "initial-compaction-unavailable");
	notify(ctx, "Post-review-loop paused because another compaction is already pending. Use /post-review-loop resume to continue explicitly.", "warning");
}

function requestInitialOneshotCompaction(pi: ExtensionAPI, ctx: ExtensionContext, scope: string, reviewOnly: boolean): void {
	const ok = agentCompaction.request(pi, ctx, {
		source: "post-review-loop:oneshot",
		message: initialCompactionRequestMessage("oneshot", scope, "the extension will inject the stateless one-shot review prompt"),
		details: { scope, reviewOnly },
		onComplete: () => {
			pi.sendUserMessage(oneshotPrompt(scope, { reviewOnly }), { deliverAs: "followUp" });
		},
		onError: (_pi, _ctx, error) => {
			notify(ctx, `Post-review-loop oneshot paused because initial compaction failed: ${error.message}. Rerun /post-review-loop oneshot when ready.`, "error");
		},
	});
	if (ok) return;
	notify(ctx, "Post-review-loop oneshot paused because another compaction is already pending. Rerun /post-review-loop oneshot when ready.", "warning");
}

function registerCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: "Run the deterministic post-review-loop workflow or a stateless oneshot review",
		getArgumentCompletions(prefix) {
			const options = [
				"oneshot",
				"oneshot --review-only",
				"start",
				"start --limit 3",
				"start --review-only",
				"start --no-git-checkpoint",
				"status",
				"status --full",
				"pause",
				"resume",
				"stop",
				"cancel",
				"report",
				"report --full",
			];
			const filtered = options.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcommand = "status", ...rest] = trimmed ? trimmed.split(/\s+/) : ["status"];
			const restText = rest.join(" ");

			if (subcommand === "status") {
				const state = runtime.state;
				showMarkdownMessage(pi, ctx, "Post-review-loop status", statusMarkdown(state, { full: rest.includes("--full"), currentFingerprint: currentFingerprintForState(ctx, state) }));
				return;
			}

			if (subcommand === "cancel") {
				const result = cancelLoop(pi, ctx);
				if (!result.hadState && !result.hadPendingPrompt && !result.hadPendingCompaction) {
					notify(ctx, "No post-review-loop state to cancel.", "info");
					return;
				}
				notify(
					ctx,
					`Post-review-loop cancelled and state cleared.${result.hadPendingPrompt ? " Pending phase prompt discarded." : ""}${result.hadPendingCompaction ? " Pending initial compaction discarded." : ""}${result.abortedAgent ? " Active agent turn aborted." : ""}`,
					"info",
				);
				if (result.abortedAgent) ctx.abort();
				return;
			}

			if (subcommand === "pause") {
				const before = runtime.state;
				if (before?.lifecycle === "paused") {
					notify(ctx, "Post-review-loop is already paused.", "info");
					return;
				}
				const state = runtime.requestAfterCurrentIteration("pause");
				if (!state) {
					notify(ctx, "No running post-review-loop to pause.", "warning");
					return;
				}
				persist(pi, ctx, "pause-requested");
				notify(ctx, `Post-review-loop will pause after iteration ${state.controlRequest?.afterIteration ?? state.iteration}.`, "info");
				return;
			}

			if (subcommand === "resume") {
				const state = runtime.resume();
				if (!state) {
					notify(ctx, "No paused post-review-loop to resume.", "warning");
					return;
				}
				persist(pi, ctx, "resumed");
				notify(ctx, "Post-review-loop resumed.", "info");
				pi.sendUserMessage(resumePrompt(state, { currentFingerprint: currentFingerprintForState(ctx, state) }), { deliverAs: "followUp" });
				return;
			}

			if (subcommand === "report") {
				showMarkdownMessage(pi, ctx, "Post-review-loop report", renderReportOnly({ full: rest.includes("--full") }));
				return;
			}

			if (subcommand === "stop") {
				const state = runtime.state;
				if (!state) {
					notify(ctx, "No post-review-loop state to stop.", "warning");
					return;
				}
				if (state.lifecycle === "complete") {
					const report = completeWithReport(pi, ctx, "stopped");
					showMarkdownMessage(pi, ctx, "Post-review-loop final report", report);
					return;
				}
				const requested = runtime.requestAfterCurrentIteration("stop");
				if (!requested) {
					notify(ctx, "No running post-review-loop to stop.", "warning");
					return;
				}
				persist(pi, ctx, "stop-requested");
				notify(ctx, `Post-review-loop will stop after iteration ${requested.controlRequest?.afterIteration ?? requested.iteration}.`, "info");
				return;
			}

			if (subcommand === "start") {
				const existing = runtime.state;
				if (existing && existing.lifecycle !== "complete") {
					const ok = await ctx.ui.confirm("Replace active post-review-loop?", statusText(existing));
					if (!ok) return;
				}
				const parsed = parseStartArgs(restText);
				const scope = parsed.scope || DEFAULT_REVIEW_SCOPE;
				const state = startLoop(pi, ctx, scope, { limit: parsed.limit, reviewOnly: parsed.reviewOnly, gitCheckpoint: parsed.gitCheckpoint });
				notify(ctx, `Post-review-loop started: ${compactText(state.scope)}; initial compaction required before the first phase.`, "info");
				requestInitialLoopCompaction(pi, ctx, state);
				return;
			}

			if (subcommand === "oneshot") {
				const parsed = parseOneshotArgs(restText);
				const scope = parsed.scope || DEFAULT_REVIEW_SCOPE;
				notify(ctx, `Post-review-loop oneshot: ${compactText(scope)}; initial compaction required before review.`, "info");
				requestInitialOneshotCompaction(pi, ctx, scope, parsed.reviewOnly);
				return;
			}

			notify(ctx, `Unknown subcommand: ${subcommand}. Use oneshot, start, status, pause, resume, stop, cancel, or report.`, "warning");
		},
	});
}

export default function postReviewLoop(pi: ExtensionAPI): void {
	agentCompaction.register(pi);
	registerMarkdownRenderer(pi);
	registerCommand(pi, "post-review-loop");

	pi.registerTool({
		name: "post_review_loop_get_state",
		label: "Get Post Review Loop State",
		description: "Get the active post-review-loop state and next required action.",
		promptSnippet: "Inspect the current post-review-loop phase, iteration, ledger, and required next action.",
		promptGuidelines: ["Use when unsure which post-review-loop phase is active.", "Do not continue a different phase than the state reports."],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = runtime.state;
			const currentFingerprint = currentFingerprintForState(ctx, state);
			const returnFinalReport = state?.lifecycle === "complete";
			const markdown = statusMarkdown(state, { full: returnFinalReport, currentFingerprint });
			return textToolResult(markdown, compactToolDetails(state, returnFinalReport ? { currentFingerprint, report: markdown } : { currentFingerprint }));
		},
		renderResult(result) {
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			return markdownComponent(text);
		},
	});

	pi.registerTool({
		name: "post_review_loop_submit_phase_result",
		label: "Submit Post Review Loop Phase Result",
		description: "Submit structured facts for the completed post-review-loop phase. The extension decides stop vs continue.",
		promptSnippet: "Submit the completed phase result after real inspection, edits, and validation for the current post-review-loop phase.",
		promptGuidelines: [
			"Call only at the end of the active post-review-loop phase.",
			"The extension, not the model, decides whether to continue or stop.",
			"Classify each Bucket I and Bucket II item with designSignal so reports explain the root-cause/design-smell category, not just the fix.",
			"Treat accepted Bucket I as auto-fix-track work: impl phases should apply it unless a concrete blocker exists; candidates are not fixed during review-only phases.",
			"Only submit new or materially changed Bucket II items; reuse the existing title verbatim for updates and omit unchanged existing Bucket II items.",
			"Include commitMessage when the reviewed work is clear; write a normal project commit message, not checkpoint or post-review-loop metadata.",
			"After a continue result, stop substantial work until the next phase prompt arrives.",
		],
		parameters: SubmitPhaseResultSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: PhaseResult, _signal, _onUpdate, ctx) {
			try {
				const normalized = normalizePhaseResult(params);
				const priorState = runtime.state;
				const cacheFiles = priorState
					? unique([
							...fingerprintFiles(priorState),
							...normalized.changedFiles,
							...normalized.codeChanges.flatMap((item) => item.files),
							...normalized.bucketI.flatMap((item) => item.files),
						])
					: [];
				const fingerprint = computeWorktreeFingerprint(ctx.cwd, cacheFiles);
				const { state, gate } = runtime.submit(normalized, fingerprint ? { cwd: ctx.cwd, fingerprint } : undefined);
				persist(pi, ctx, "phase-submitted");
				if (gate.decision === "stop") {
					if (needsAgentSelectedAfterReviewCommit(ctx.cwd, state)) {
						startFinalCommitSelection(pi, ctx);
						return textToolResult(
							"Post-review-loop reached its final gate. A selective after-review commit prompt is queued; commit only loop-applied edits, then call post_review_loop_submit_final_commit_result.",
							compactToolDetails(runtime.state, { gate, finalCommitSelectionPending: true }),
							false,
							true,
						);
					}
					const report = completeWithReport(pi, ctx, "final-report-rendered");
					queueMarkdownMessageAfterAgent("Post-review-loop final report", report);
					return textToolResult(`Post-review-loop stopped. Final report:\n\n${report}`, compactToolDetails(runtime.state, { gate, report }), false, true);
				}

				if (state.lifecycle === "paused") {
					return textToolResult(
						"Phase result accepted. Current iteration completed and the loop is paused before the next phase prompt. Use /post-review-loop resume to continue explicitly.",
						compactToolDetails(state, {
							gate,
							notify: {
								suppressCompletion: true,
								status: "Paused",
								logMessage: "Post-review-loop iteration accepted; loop paused before next phase",
							},
						}),
						false,
						true,
					);
				}

				queuePhasePromptAfterAgent(state);
				return textToolResult(
					`Phase result accepted. Gate decision: continue to ${gate.nextPhase}. The next authoritative phase prompt is queued; stop substantial work for this turn.`,
					compactToolDetails(state, {
						gate,
						nextPhasePromptPending: true,
						notify: {
							suppressCompletion: true,
							status: "Continuing",
							logMessage: "Post-review-loop phase accepted; next phase prompt queued",
						},
					}),
					false,
					true,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textToolResult(message, compactToolDetails(runtime.state, { error: message }), true, false);
			}
		},
	});

	pi.registerTool({
		name: "post_review_loop_submit_final_commit_result",
		label: "Submit Post Review Loop Final Commit Result",
		description: "Submit the result of the selective after-review commit step and render the final report.",
		promptSnippet: "After the final commit prompt, report whether loop-applied edits were selectively committed or intentionally left uncommitted.",
		promptGuidelines: [
			"Use only when post-review-loop asks for the selective after-review commit result.",
			"Commit only loop-applied edits; use partial hunk staging when unrelated work shares a file.",
			"Do not create duplicate commits when the loop-applied edits are already committed.",
		],
		parameters: FinalCommitResultSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: { committed: boolean; ref?: string; files: string[]; notes: string }, _signal, _onUpdate, ctx) {
			try {
				const state = runtime.state;
				if (!state) throw new Error("No post-review-loop is active.");
				if (state.lifecycle !== "finalizing") throw new Error(`Loop is ${state.lifecycle}; final commit result is not expected now.`);
				const afterReviewCommit: AfterReviewCommitState = {
					ref: params.committed ? (params.ref?.trim() || "unknown") : "None",
					mode: params.committed ? "agent-selected-after-review" : "left-uncommitted",
					files: unique(params.files),
					notes: params.notes.trim(),
				};
				runtime.recordAfterReviewCommit(afterReviewCommit);
				persist(pi, ctx, "final-commit-submitted");
				const report = completeWithReport(pi, ctx, "final-report-rendered", { skipCommit: true });
				queueMarkdownMessageAfterAgent("Post-review-loop final report", report);
				return textToolResult(`Post-review-loop stopped. Final report:\n\n${report}`, compactToolDetails(runtime.state, { report }), false, true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textToolResult(message, compactToolDetails(runtime.state, { error: message }), true);
			}
		},
	});

	pi.registerTool({
		name: "post_review_loop_abort",
		label: "Abort Post Review Loop",
		description: "Stop the active post-review-loop with a structured reason when scope, context, approval, or validation blocks safe continuation.",
		parameters: AbortSchema,
		async execute(_toolCallId, params: { reason: string }, _signal, _onUpdate, ctx) {
			try {
				runtime.abort(params.reason);
				const report = completeWithReport(pi, ctx, "aborted");
				queueMarkdownMessageAfterAgent("Post-review-loop final report", report);
				return textToolResult(`Post-review-loop aborted. Final report:\n\n${report}`, compactToolDetails(runtime.state, { report }), false, true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textToolResult(message, compactToolDetails(runtime.state, { error: message }), true);
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		agentActive = false;
		pendingMarkdownMessages.splice(0);
		pendingPhasePrompt = null;
		clearScheduledPhasePrompt();
		runtime.restore(latestStateFromSession(ctx));
		const state = runtime.state;
		if (state?.lifecycle === "checkpointing") {
			runtime.pauseWithError("Session restored from a legacy checkpointing state; checkpoint was not completed.");
			persist(pi, ctx, "checkpoint-restored-paused");
			notify(ctx, "Post-review-loop restored from a legacy checkpointing state and paused. Use /post-review-loop resume.", "warning");
			return;
		}
		if (state?.lifecycle === "active" && event.reason === "reload") {
			runtime.pauseImmediately();
			persist(pi, ctx, "reload-paused");
			notify(ctx, "Post-review-loop paused after reload. Use /post-review-loop resume.", "info");
			return;
		}
		updateStatus(ctx);
		if (state && state.lifecycle !== "complete") notify(ctx, `Post-review-loop restored: ${state.lifecycle} ${state.phase} ${state.iteration}/${state.limit}`, "info");
	});

	pi.on("session_tree", (_event, ctx) => {
		pendingPhasePrompt = null;
		clearScheduledPhasePrompt();
		runtime.restore(latestStateFromSession(ctx));
		updateStatus(ctx);
	});

	pi.on("agent_start", () => {
		agentActive = true;
	});

	pi.on("agent_end", (_event, ctx) => {
		agentActive = false;
		flushQueuedPhasePromptAfterAgent(pi, ctx);
		flushQueuedMarkdownMessagesAfterAgent(pi, ctx);
	});

	pi.on("session_shutdown", () => {
		agentActive = false;
		pendingMarkdownMessages.splice(0);
		pendingPhasePrompt = null;
		clearScheduledPhasePrompt();
	});
}
