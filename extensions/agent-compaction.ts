import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type ContextUsage = ReturnType<ExtensionContext["getContextUsage"]>;
type ToolTextResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; terminate?: boolean };

type CompactionResult = {
	requestId: string;
	summaryChars: number;
	tokensBefore: number;
	timestamp: number;
	source?: string;
};

type CompletionBehavior = "continue" | "announce-and-stop" | "silent-stop";

type AgentCompactionRequest = {
	source: string;
	message: string;
	details?: Record<string, unknown>;
	/** Defaults to continuing the task for workflow-driven compactions. Manual compaction commands should stop. */
	completionBehavior?: CompletionBehavior;
	onComplete?: (pi: ExtensionAPI, ctx: ExtensionContext, result: CompactionResult) => void;
	onError?: (pi: ExtensionAPI, ctx: ExtensionContext, error: Error, requestId: string) => void;
};

type GuardState = {
	lastCompaction?: CompactionResult;
};

type PendingAgentRequest = AgentCompactionRequest & {
	requestId: string;
	requestedAt: number;
};

type AcceptedCompaction = {
	requestId: string;
	summary: string;
	usage: ContextUsage;
	acceptedAt: number;
	/** The physical session replacement is explicit because some callers require a real compaction, not only a handoff summary. */
	physicalCompaction: "required";
	request?: PendingAgentRequest;
};

type CompactionState =
	| { status: "idle" }
	| { status: "requested"; request: PendingAgentRequest }
	| { status: "delivered"; request: PendingAgentRequest }
	| { status: "accepted"; compaction: AcceptedCompaction }
	| { status: "compacting"; compaction: AcceptedCompaction }
	| { status: "completed"; result: CompactionResult }
	| { status: "failed"; requestId: string; source?: string; error: string }
	| { status: "cancelled"; source?: string };

const STATE_ENTRY_TYPE = "agent-compaction-state";
const COMPACTION_DETAILS_SOURCE = "context-compaction-guard-state";
const MESSAGE_TYPE = "context-compaction-guard";
const FULL_REPLACEMENT_SENTINEL = "context-compaction-guard:no-kept-entry";

function newRequestId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function textToolResult(text: string, details?: unknown, terminate = false): ToolTextResult {
	return { content: [{ type: "text", text }], details, terminate };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
}

function customMessage(content: string, details?: unknown): any {
	return {
		role: "custom",
		customType: MESSAGE_TYPE,
		content,
		display: true,
		details,
		timestamp: Date.now(),
	};
}

function buildCompactionCompleteMessage(result: { summaryChars: number; tokensBefore: number }): string {
	return `Agent-driven context compaction completed.

The previous conversation context was replaced with the high-fidelity compacted working context you submitted (${result.summaryChars.toLocaleString()} chars, replacing about ${result.tokensBefore.toLocaleString()} tokens before compaction).

Continue the user's task from this compacted context. Avoid rereading files whose needed contents are already captured; reread only when the compacted context is insufficient, stale, or exact current file contents are required.`;
}

function buildCompactionStoppedMessage(result: { summaryChars: number; tokensBefore: number }): string {
	return `Agent-driven context compaction completed.

The previous conversation context was replaced with the high-fidelity compacted working context you submitted (${result.summaryChars.toLocaleString()} chars, replacing about ${result.tokensBefore.toLocaleString()} tokens before compaction).

Stop here. Wait for the human user's next message before continuing work.`;
}

function buildCompactionFailedMessage(error: Error): string {
	return `Agent-driven context compaction failed: ${error.message}

Continue the user's task using the current context. Do not retry compaction immediately unless you can address the failure and the context remains high enough to justify it.`;
}

export class AgentCompactionController {
	#registered = false;
	#registeredFor = new WeakSet<ExtensionAPI>();
	#state: CompactionState = { status: "idle" };
	#scheduledMessage: ReturnType<typeof setTimeout> | null = null;
	#scheduleVersion = 0;

	get busy(): boolean {
		return this.#isActive(this.#state);
	}

	get pendingSource(): string | undefined {
		return this.#sourceFor(this.#state);
	}

	clearSource(sourcePrefix: string): boolean {
		const source = this.pendingSource;
		if (!source?.startsWith(sourcePrefix)) return false;
		this.clear();
		return true;
	}

	register(pi: ExtensionAPI): void {
		if (this.#registered || this.#registeredFor.has(pi)) return;
		this.#registered = true;
		this.#registeredFor.add(pi);

		try {
			pi.registerTool({
				name: "compact_conversation",
				label: "Compact Conversation",
				description: "Replace previous conversation context with an agent-authored high-fidelity compacted working context.",
				promptSnippet: "Replace previous conversation context with a high-fidelity compacted working context when context usage is high.",
				promptGuidelines: [
					"Use compact_conversation only after a context-compaction checkpoint or workflow kickoff asks you to compact or decide whether compaction is worthwhile.",
					"The compact_conversation summary should be a dense working context for an LLM, not a short human summary; include relevant file contents and exact details needed to avoid unnecessary rereads.",
					"Do not overuse compact_conversation. If the current context is still useful and not noisy, continue without compacting.",
				],
				parameters: Type.Object({
					summary: Type.String({
						minLength: 1,
						description:
							"High-fidelity compacted working context that will replace previous conversation history. It may be long and should preserve exact task state, decisions, file contents/snippets, validation, and next steps needed to continue.",
					}),
				}),
				executionMode: "sequential",
				async execute(_toolCallId, params: { summary: string }, _signal, _onUpdate, ctx) {
					return agentCompaction.acceptCompaction(pi, ctx, params.summary);
				},
			});

			pi.on("session_start", () => {
				this.clear();
			});

			pi.on("session_tree", () => {
				this.clear();
			});

			pi.on("session_before_compact", (event) => {
				const compaction = this.#currentCompaction();
				if (!compaction) return;
				return {
					compaction: {
						summary: compaction.summary,
						firstKeptEntryId: `${FULL_REPLACEMENT_SENTINEL}:${compaction.requestId}`,
						tokensBefore: event.preparation.tokensBefore,
						details: {
							source: COMPACTION_DETAILS_SOURCE,
							requestId: compaction.requestId,
							summaryChars: compaction.summary.length,
							fullReplacement: true,
							requestSource: compaction.request?.source,
							physicalCompaction: compaction.physicalCompaction,
						},
					},
				};
			});

			pi.on("session_compact", (event, ctx) => {
				const compaction = this.#currentCompaction();
				if (!compaction) return;
				const details = event.compactionEntry.details as { requestId?: string; source?: string } | undefined;
				if (details?.source !== COMPACTION_DETAILS_SOURCE || details.requestId !== compaction.requestId) return;
				this.complete(pi, ctx, event.compactionEntry.tokensBefore);
			});

			pi.on("agent_end", (_event, ctx) => {
				this.runAfterAgent(pi, ctx);
			});

			pi.on("session_shutdown", () => {
				this.clear();
				this.#registered = false;
				this.#registeredFor = new WeakSet<ExtensionAPI>();
			});
		} catch (error) {
			this.#registered = false;
			this.#registeredFor.delete(pi);
			throw error;
		}
	}

	request(pi: ExtensionAPI, ctx: ExtensionContext, request: AgentCompactionRequest): boolean {
		if (this.busy) return false;
		const pending: PendingAgentRequest = { ...request, requestId: newRequestId(), requestedAt: Date.now() };
		this.#transitionTo({ status: "requested", request: pending });
		notify(ctx, "Agent-driven context compaction requested", "info");
		this.#sendCustomMessageWhenIdle(pi, ctx, request.message, { requestId: pending.requestId, source: request.source, ...request.details }, () => {
			if (this.#state.status === "requested" && this.#state.request.requestId === pending.requestId) {
				this.#transitionTo({ status: "delivered", request: pending });
			}
		});
		return true;
	}

	acceptCompaction(pi: ExtensionAPI, ctx: ExtensionContext, rawSummary: string): ToolTextResult {
		if (this.#state.status === "accepted" || this.#state.status === "compacting") {
			return textToolResult("A context compaction is already pending. Stop work and wait for it to complete.", { pending: true }, true);
		}

		const summary = rawSummary.trim();
		if (!summary) throw new Error("summary must not be empty");

		const request = this.#requestFor(this.#state);
		const completionBehavior = request?.completionBehavior ?? "continue";
		const compaction: AcceptedCompaction = {
			requestId: request?.requestId ?? newRequestId(),
			summary,
			usage: ctx.getContextUsage(),
			acceptedAt: Date.now(),
			physicalCompaction: "required",
			request: request ?? undefined,
		};
		this.#transitionTo({ status: "accepted", compaction });

		notify(ctx, "Agent-driven context compaction queued", "info");
		return textToolResult(
			completionBehavior === "continue"
				? "Compaction accepted and queued. Stop this turn now; the extension will replace previous context with your compacted working context and then continue automatically."
				: "Compaction accepted and queued. Stop this turn now; the extension will replace previous context with your compacted working context and wait for the human user's next message.",
			{
				requestId: compaction.requestId,
				summaryChars: summary.length,
				usage: compaction.usage,
				requestSource: request?.source,
				completionBehavior,
				physicalCompaction: compaction.physicalCompaction,
			},
			true,
		);
	}

	clear(): void {
		const source = this.pendingSource;
		this.#transitionTo(source ? { status: "cancelled", source } : { status: "cancelled" });
		this.clearScheduledMessage();
		this.#transitionTo({ status: "idle" });
	}

	#persistState(pi: ExtensionAPI, state: GuardState = {}): void {
		pi.appendEntry(STATE_ENTRY_TYPE, state);
	}

	#isActive(state: CompactionState): boolean {
		return state.status === "requested" || state.status === "delivered" || state.status === "accepted" || state.status === "compacting";
	}

	#sourceFor(state: CompactionState): string | undefined {
		switch (state.status) {
			case "requested":
			case "delivered":
				return state.request.source;
			case "accepted":
			case "compacting":
				return state.compaction.request?.source;
			case "completed":
				return state.result.source;
			case "failed":
			case "cancelled":
				return state.source;
			case "idle":
				return undefined;
		}
	}

	#requestFor(state: CompactionState): PendingAgentRequest | undefined {
		if (state.status === "requested" || state.status === "delivered") return state.request;
		if (state.status === "accepted" || state.status === "compacting") return state.compaction.request;
		return undefined;
	}

	#currentCompaction(): AcceptedCompaction | undefined {
		if (this.#state.status === "accepted" || this.#state.status === "compacting") return this.#state.compaction;
		return undefined;
	}

	#transitionTo(next: CompactionState): void {
		this.#state = next;
	}

	clearScheduledMessage(): void {
		this.#scheduleVersion += 1;
		if (!this.#scheduledMessage) return;
		clearTimeout(this.#scheduledMessage);
		this.#scheduledMessage = null;
	}

	#sendCustomMessageWhenIdle(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		content: string,
		details?: unknown,
		onSend?: () => void,
		options: { triggerTurn?: boolean } = { triggerTurn: true },
	): void {
		this.clearScheduledMessage();
		const version = this.#scheduleVersion;
		const poll = () => {
			if (version !== this.#scheduleVersion) return;
			if (!ctx.isIdle()) {
				this.#scheduledMessage = setTimeout(poll, 25);
				return;
			}
			this.#scheduledMessage = null;
			onSend?.();
			pi.sendMessage(customMessage(content, details), { deliverAs: "followUp", triggerTurn: options.triggerTurn });
		};
		this.#scheduledMessage = setTimeout(poll, 25);
	}

	complete(pi: ExtensionAPI, ctx: ExtensionContext, tokensBefore: number): void {
		const compaction = this.#currentCompaction();
		if (!compaction) return;
		const result: CompactionResult = {
			requestId: compaction.requestId,
			summaryChars: compaction.summary.length,
			tokensBefore,
			timestamp: Date.now(),
			source: compaction.request?.source,
		};
		const request = compaction.request;
		this.#transitionTo({ status: "completed", result });
		this.#persistState(pi, { lastCompaction: result });
		notify(ctx, "Agent-driven context compaction completed", "info");
		this.#transitionTo({ status: "idle" });
		if (request?.onComplete) {
			request.onComplete(pi, ctx, result);
			return;
		}
		const completionBehavior = request?.completionBehavior ?? "continue";
		if (completionBehavior === "silent-stop") return;
		const shouldContinue = completionBehavior === "continue";
		this.#sendCustomMessageWhenIdle(
			pi,
			ctx,
			shouldContinue ? buildCompactionCompleteMessage(result) : buildCompactionStoppedMessage(result),
			{ result },
			undefined,
			{ triggerTurn: shouldContinue },
		);
	}

	fail(pi: ExtensionAPI, ctx: ExtensionContext, error: Error): void {
		const request = this.#requestFor(this.#state);
		const compaction = this.#currentCompaction();
		const effectiveRequestId = compaction?.requestId ?? request?.requestId ?? newRequestId();
		const source = compaction?.request?.source ?? request?.source;
		this.#transitionTo({ status: "failed", requestId: effectiveRequestId, source, error: error.message });
		notify(ctx, `Agent-driven context compaction failed: ${error.message}`, "error");
		this.#transitionTo({ status: "idle" });
		if (request?.onError) {
			request.onError(pi, ctx, error, effectiveRequestId);
			return;
		}
		this.#sendCustomMessageWhenIdle(pi, ctx, buildCompactionFailedMessage(error), { error: error.message, requestId: effectiveRequestId });
	}

	runAfterAgent(pi: ExtensionAPI, ctx: ExtensionContext): void {
		switch (this.#state.status) {
			case "requested":
				return;
			case "delivered":
				this.fail(pi, ctx, new Error("the agent did not call compact_conversation for the required compaction request"));
				return;
			case "accepted": {
				const compaction = this.#state.compaction;
				this.#transitionTo({ status: "compacting", compaction });
				notify(ctx, "Agent-driven context compaction started", "info");
				try {
					ctx.compact({
						customInstructions: "Use the agent-provided high-fidelity compacted working context from compact_conversation. Do not generate a separate summary.",
						onComplete: (result) => this.complete(pi, ctx, result.tokensBefore),
						onError: (error) => this.fail(pi, ctx, error),
					});
				} catch (error) {
					this.fail(pi, ctx, error instanceof Error ? error : new Error(String(error)));
				}
				return;
			}
			case "compacting":
			case "idle":
			case "completed":
			case "failed":
			case "cancelled":
				return;
		}
	}
}

// Pi can load package extension entrypoints through isolated module contexts, so share the
// controller through process rather than context-local globalThis. This keeps the
// compact_conversation tool registered exactly once while letting sibling extensions call
// the same controller instance.
const AGENT_COMPACTION_PROCESS_KEY = "__sjuneparkPiPersonalAgentCompaction" as const;
const agentCompactionProcess = process as typeof process & {
	[AGENT_COMPACTION_PROCESS_KEY]?: AgentCompactionController;
};

export const agentCompaction = (agentCompactionProcess[AGENT_COMPACTION_PROCESS_KEY] ??= new AgentCompactionController());

export default function agentCompactionExtension(pi: ExtensionAPI): void {
	agentCompaction.register(pi);
}
