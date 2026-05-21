import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { ReviewLoopCompactor } from "./compact.js";
import { computeWorktreeFingerprint, createAfterReviewCommit, establishBaseline, failedAfterReviewCommit } from "./git.js";
import { currentBucketIItems, currentBucketIIItems } from "./ledger.js";
import { phasePrompt, renderReusableEvidenceForStatus, resumePrompt } from "./prompts.js";
import { renderCurrentReport, renderFinalReport } from "./report.js";
import { latestStateFromSession, ReviewLoopRuntime } from "./state.js";
import type { BucketIStatus, BucketIIStatus, LoopState, PhaseResult, WorktreeFingerprint } from "./types.js";
import { ENTRY_TYPE, STATUS_KEY } from "./types.js";

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean; terminate?: boolean };
type MarkdownConstructor = new (text: string, paddingX: number, paddingY: number, theme: unknown) => unknown;
type RuntimeDeps = { Markdown: MarkdownConstructor; getMarkdownTheme: () => unknown };
type PendingMarkdownMessage = { title: string; markdown: string };

const runtime = new ReviewLoopRuntime();
const compactor = new ReviewLoopCompactor();
let runtimeDeps: RuntimeDeps | undefined;
const pendingMarkdownMessages: PendingMarkdownMessage[] = [];
let agentActive = false;
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
	status: BucketIStatusSchema,
	fix: Type.String({ minLength: 1 }),
	files: Type.Array(Type.String()),
	bandageReason: Type.String({ minLength: 1 }),
	validation: Type.Array(Type.String()),
});

const BucketIISchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	revealed: Type.String({ minLength: 1 }),
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
			content: title,
			display: true,
			details: { markdown },
		},
		options,
	);
}

function queueMarkdownMessageAfterAgent(title: string, markdown: string): void {
	pendingMarkdownMessages.push({ title, markdown });
}

function showMarkdownMessage(pi: ExtensionAPI, title: string, markdown: string): void {
	if (agentActive) {
		queueMarkdownMessageAfterAgent(title, markdown);
		return;
	}
	sendMarkdownMessage(pi, title, markdown);
}

function flushQueuedMarkdownMessagesAfterAgent(pi: ExtensionAPI): void {
	const messages = pendingMarkdownMessages.splice(0);
	if (!messages.length) return;
	setTimeout(() => {
		for (const message of messages) sendMarkdownMessage(pi, message.title, message.markdown);
	}, 0);
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
	const failedValidation = state.validation.filter((item) => item.result === "failed").slice(-3);
	return [
		"# Post-Review Loop Status",
		"",
		`- Lifecycle: ${state.lifecycle}`,
		`- Phase: ${state.phase}`,
		`- Iteration: ${state.iteration}/${state.limit}`,
		`- Scope: ${compactStatusText(state.scope, 600)}`,
		`- Last gate: ${state.lastGate ? `${state.lastGate.decision}: ${compactStatusText(state.lastGate.reason, 260)}` : "none"}`,
		compactor.pending ? "- Checkpoint: pending" : "- Checkpoint: none",
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
	if (state.lifecycle === "complete" || state.phase === "final-report") return renderFinalReport(state, { full: true });
	return renderCurrentReport(state, { full: true });
}

function statusMarkdown(state: LoopState | null, options: { full?: boolean; currentFingerprint?: WorktreeFingerprint } = {}): string {
	return options.full ? fullStatusMarkdown(state) : compactStatusMarkdown(state, options);
}

function requiredNextAction(state: LoopState): string {
	if (state.lifecycle === "checkpointing") return "Stop substantial work and wait for checkpoint compaction to finish.";
	if (state.lifecycle === "paused") return "Resume the loop before submitting another phase result.";
	if (state.phase === "final-report") return "Render or inspect the final report.";
	return `Complete ${state.phase} iteration ${state.iteration}, then call post_review_loop_submit_phase_result.`;
}

function compactToolDetails(state: LoopState | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
	if (!state) return { state: null, checkpointPending: compactor.pending, ...extra };
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
			actionableBucketI: compactStatusArray(currentBucketI.filter((item) => item.status === "candidate" || item.status === "accepted" || item.status === "remaining").map((item) => item.title)),
			unresolvedBucketII: compactStatusArray(
				currentBucketII.filter((item) => item.status === "left for user decision" || item.status === "deferred" || item.status === "kept as-is for now").map((item) => item.title),
			),
			failedValidation: state.validation
				.filter((item) => item.result === "failed")
				.slice(-3)
				.map((item) => ({ ...item, command: compactStatusText(item.command), notes: compactStatusText(item.notes, 260) })),
			requiredNextAction: requiredNextAction(state),
		},
		checkpointPending: compactor.pending,
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

function parseStartArgs(args: string): { scope: string; limit?: number; reviewOnly: boolean; gitCheckpoint: boolean } {
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
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

function renderReportOnly(options: { full?: boolean } = {}): string {
	const state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	return state.lifecycle === "complete" || state.phase === "final-report" ? renderFinalReport(state, options) : renderCurrentReport(state, options);
}

const BUCKET_I_STATUSES: BucketIStatus[] = ["candidate", "accepted", "applied", "rejected", "remaining", "downgraded"];
const BUCKET_II_STATUSES: BucketIIStatus[] = ["left for user decision", "deferred", "kept as-is for now", "implemented after explicit approval"];
const BUCKET_I_STATUS_BY_KEY = new Map<string, BucketIStatus>(BUCKET_I_STATUSES.map((status): [string, BucketIStatus] => [status, status]));
const BUCKET_II_STATUS_BY_KEY = new Map<string, BucketIIStatus>(BUCKET_II_STATUSES.map((status): [string, BucketIIStatus] => [status, status]));
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

function normalizePhaseResult(params: PhaseResult): PhaseResult {
	return {
		...params,
		validation: params.validation.map((item) => ({ ...item, source: normalizeValidationSource(item.source) })),
		bucketI: params.bucketI.map((item) => ({ ...item, status: normalizeBucketIStatus(String(item.status)) })),
		bucketII: params.bucketII.map((item) => ({ ...item, status: normalizeBucketIIStatus(String(item.status)) })),
	};
}

function registerMarkdownRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(MARKDOWN_MESSAGE_TYPE, (message) => {
		const details = message.details as { markdown?: string } | undefined;
		const fallback = typeof message.content === "string" ? message.content : "";
		return markdownComponent(details?.markdown ?? fallback);
	});
}

function completeWithReport(pi: ExtensionAPI, ctx: ExtensionContext, event: string): string {
	let state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	try {
		runtime.recordAfterReviewCommit(createAfterReviewCommit(ctx.cwd, state));
	} catch (error) {
		runtime.recordAfterReviewCommit(failedAfterReviewCommit(ctx.cwd, state, error), error instanceof Error ? error.message : String(error));
	}
	state = runtime.state;
	if (!state) throw new Error("No post-review-loop state.");
	const report = renderFinalReport(state);
	runtime.completeWithReport(report);
	persist(pi, ctx, event);
	return report;
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

function registerCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: "Run the deterministic post-review-loop workflow",
		getArgumentCompletions(prefix) {
			const options = ["start", "start --limit 3", "start --review-only", "start --no-git-checkpoint", "status", "status --full", "pause", "resume", "stop", "report", "report --full", "clear"];
			const filtered = options.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcommand = "status", ...rest] = trimmed ? trimmed.split(/\s+/) : ["status"];
			const restText = rest.join(" ");

			if (subcommand === "status") {
				const state = runtime.state;
				showMarkdownMessage(pi, "Post-review-loop status", statusMarkdown(state, { full: rest.includes("--full"), currentFingerprint: currentFingerprintForState(ctx, state) }));
				return;
			}

			if (subcommand === "clear") {
				compactor.clear(pi);
				const previous = runtime.clear();
				persist(pi, ctx, "cleared");
				notify(ctx, previous ? "Post-review-loop state cleared." : "No post-review-loop state to clear.", "info");
				return;
			}

			if (subcommand === "pause") {
				const state = runtime.pause();
				if (!state) {
					notify(ctx, "No active post-review-loop to pause.", "warning");
					return;
				}
				persist(pi, ctx, "paused");
				notify(ctx, "Post-review-loop paused.", "info");
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
				showMarkdownMessage(pi, "Post-review-loop report", renderReportOnly({ full: rest.includes("--full") }));
				return;
			}

			if (subcommand === "stop") {
				const state = runtime.state;
				if (!state) {
					notify(ctx, "No post-review-loop state to stop.", "warning");
					return;
				}
				if (state.lifecycle !== "complete") runtime.abort("user stopped the loop");
				const report = completeWithReport(pi, ctx, "stopped");
				showMarkdownMessage(pi, "Post-review-loop final report", report);
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
				notify(ctx, `Post-review-loop started: ${compactText(state.scope)}`, "info");
				sendPhasePrompt(pi, ctx, state);
				return;
			}

			notify(ctx, `Unknown subcommand: ${subcommand}. Use start, status, pause, resume, stop, report, or clear.`, "warning");
		},
	});
}

export default function postReviewLoop(pi: ExtensionAPI): void {
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
			return textToolResult(statusMarkdown(state, { currentFingerprint }), compactToolDetails(state, { currentFingerprint }));
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
					const report = completeWithReport(pi, ctx, "final-report-rendered");
					queueMarkdownMessageAfterAgent("Post-review-loop final report", report);
					return textToolResult("Post-review-loop stopped. The final report will render as a separate markdown message.", compactToolDetails(runtime.state, { gate }), false, true);
				}

				const queued = compactor.queue(pi, ctx, state);
				persist(pi, ctx, queued ? "checkpoint-queued" : "checkpoint-queue-rejected");
				if (!queued) return textToolResult("A checkpoint is already pending. Stop substantial work and wait for the next phase prompt.", compactToolDetails(state, { gate }), true, true);
				return textToolResult(
					`Phase result accepted. Gate decision: continue to ${gate.nextPhase}. Checkpoint compaction is queued; stop substantial work for this turn.`,
					compactToolDetails(state, {
						gate,
						checkpointPending: true,
						notify: {
							suppressCompletion: true,
							status: "Continuing",
							logMessage: "Post-review-loop phase accepted; checkpoint compaction is queued",
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
		name: "post_review_loop_abort",
		label: "Abort Post Review Loop",
		description: "Stop the active post-review-loop with a structured reason when scope, context, approval, or validation blocks safe continuation.",
		parameters: AbortSchema,
		async execute(_toolCallId, params: { reason: string }, _signal, _onUpdate, ctx) {
			try {
				runtime.abort(params.reason);
				const report = completeWithReport(pi, ctx, "aborted");
				queueMarkdownMessageAfterAgent("Post-review-loop final report", report);
				return textToolResult("Post-review-loop aborted. The final report will render as a separate markdown message.", compactToolDetails(runtime.state), false, true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textToolResult(message, compactToolDetails(runtime.state, { error: message }), true);
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		agentActive = false;
		pendingMarkdownMessages.splice(0);
		compactor.clear(pi);
		runtime.restore(latestStateFromSession(ctx));
		const state = runtime.state;
		if (state?.lifecycle === "checkpointing") {
			runtime.markCheckpointFailed("Session restored while checkpointing; checkpoint was not completed.");
			persist(pi, ctx, "checkpoint-restored-paused");
			notify(ctx, "Post-review-loop restored from checkpointing state and paused. Use /post-review-loop resume.", "warning");
			return;
		}
		if (state?.lifecycle === "active" && event.reason === "reload") {
			runtime.pause();
			persist(pi, ctx, "reload-paused");
			notify(ctx, "Post-review-loop paused after reload. Use /post-review-loop resume.", "info");
			return;
		}
		updateStatus(ctx);
		if (state && state.lifecycle !== "complete") notify(ctx, `Post-review-loop restored: ${state.lifecycle} ${state.phase} ${state.iteration}/${state.limit}`, "info");
	});

	pi.on("session_tree", (_event, ctx) => {
		compactor.clear(pi);
		runtime.restore(latestStateFromSession(ctx));
		updateStatus(ctx);
	});

	pi.on("tool_call", (event) => {
		const reason = compactor.blockReason(event.toolName);
		return reason ? { block: true, reason } : undefined;
	});

	pi.on("agent_start", () => {
		agentActive = true;
	});

	pi.on("agent_end", (_event, ctx) => {
		agentActive = false;
		flushQueuedMarkdownMessagesAfterAgent(pi);
		compactor.runAfterAgent(
			pi,
			ctx,
			{
				markReady: () => runtime.markCheckpointReady(),
				markFailed: (error) => runtime.markCheckpointFailed(error),
			},
			(event) => persist(pi, ctx, event),
		);
	});

	pi.on("session_shutdown", () => {
		agentActive = false;
		pendingMarkdownMessages.splice(0);
		compactor.clear(pi);
	});
}
