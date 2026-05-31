import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const TOOL_MODES = ["read-only", "write", "none"] as const;
const CONTEXT_MODES = ["fresh", "fork"] as const;
const MAX_PARALLEL_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;
const MAX_MODEL_VISIBLE_OUTPUT_BYTES = 50 * 1024;
const SIMPLE_EXTRACTION_MODEL = "openai-codex/gpt-5.4-mini";
const MODEL_SELECTION_GUIDANCE = `Subagent model selection. Defaults to the parent session's current model. Use provider/model syntax, e.g. ${SIMPLE_EXTRACTION_MODEL}. Prefer ${SIMPLE_EXTRACTION_MODEL} for simple information extraction, file inventories, exact lookups, and mechanical summarization that do not need judgement; inherit the parent or choose a stronger model for coding, design review, debugging, ambiguity, synthesis, or decisions with risk.`;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type ToolMode = (typeof TOOL_MODES)[number];
type ContextMode = (typeof CONTEXT_MODES)[number];

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

type SubagentTaskConfig = {
	task: string;
	thinking?: ThinkingLevel;
	model?: string;
	context?: ContextMode;
	tools?: ToolMode;
	contextText?: string;
	cwd?: string;
};

type SubagentResult = {
	index: number;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking: ThinkingLevel;
	context: ContextMode;
	tools: ToolMode;
	cwd: string;
	durationMs: number;
	sessionFile?: string;
	stopReason?: string;
	errorMessage?: string;
};

type SubagentDetails = {
	mode: "single" | "parallel";
	results: SubagentResult[];
};

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: SubagentDetails;
	isError?: boolean;
};

type OnUpdate = ((partial: ToolResult) => void) | undefined;

const SubagentTaskSchema = Type.Object({
	task: Type.String({ description: "Concrete work to delegate to the child session." }),
	thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), {
		description: "Reasoning budget for this child. Defaults to the parent session's current thinking level.",
	})),
	model: Type.Optional(Type.String({ description: MODEL_SELECTION_GUIDANCE })),
	context: Type.Optional(Type.Union(CONTEXT_MODES.map((mode) => Type.Literal(mode)), {
		description: "fresh starts from only the supplied task/context. fork branches the current session history.",
	})),
	tools: Type.Optional(Type.Union(TOOL_MODES.map((mode) => Type.Literal(mode)), {
		description: "Tool allowlist for the child. Use read-only unless edits are explicitly delegated.",
	})),
	contextText: Type.Optional(Type.String({ description: "Clean handoff context to include before the task." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this child process." })),
});

const SubagentParams = Type.Object({
	task: Type.Optional(Type.String({ description: "Single child task. Use exactly one of task or tasks." })),
	tasks: Type.Optional(Type.Array(SubagentTaskSchema, {
		description: "Parallel child tasks. Each item starts a generic child session, not a role agent.",
		maxItems: MAX_PARALLEL_TASKS,
	})),
	thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), {
		description: "Default thinking level for child task(s). Defaults to the parent session's current thinking level.",
	})),
	model: Type.Optional(Type.String({ description: `Default model for child task(s). ${MODEL_SELECTION_GUIDANCE}` })),
	context: Type.Optional(Type.Union(CONTEXT_MODES.map((mode) => Type.Literal(mode)), {
		description: "Default context mode. fresh is the default and keeps the child context clean.",
	})),
	tools: Type.Optional(Type.Union(TOOL_MODES.map((mode) => Type.Literal(mode)), {
		description: "Default child tool mode. read-only is the default.",
	})),
	contextText: Type.Optional(Type.String({ description: "Default clean handoff context for child task(s)." })),
	cwd: Type.Optional(Type.String({ description: "Default working directory for child task(s)." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PARALLEL_TASKS, description: "Parallel concurrency. Default is 4." })),
	maxOutputBytes: Type.Optional(Type.Integer({
		minimum: 1000,
		maximum: MAX_MODEL_VISIBLE_OUTPUT_BYTES,
		description: "Max bytes returned to the parent model per child session. Full messages remain in tool details. Default is 20000.",
	})),
});

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function currentModel(ctx: ExtensionContext): string | undefined {
	const provider = ctx.model?.provider?.trim();
	const id = ctx.model?.id?.trim();
	return provider && id ? `${provider}/${id}` : undefined;
}

function currentThinking(pi: ExtensionAPI): ThinkingLevel {
	const level = pi.getThinkingLevel?.();
	return THINKING_LEVELS.includes(level as ThinkingLevel) ? (level as ThinkingLevel) : "medium";
}

function splitModelThinking(model: string | undefined): { model?: string; thinking?: ThinkingLevel } {
	if (!model) return {};
	const colon = model.lastIndexOf(":");
	if (colon === -1) return { model };

	const suffix = model.slice(colon + 1);
	if (!THINKING_LEVELS.includes(suffix as ThinkingLevel)) return { model };
	return { model: model.slice(0, colon), thinking: suffix as ThinkingLevel };
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

type SubagentStatus = "running" | "succeeded" | "failed";

function subagentStatus(result: SubagentResult): SubagentStatus {
	if (result.exitCode === -1) return "running";
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") return "failed";
	return "succeeded";
}

function isFailed(result: SubagentResult): boolean {
	return subagentStatus(result) === "failed";
}

function resultOutput(result: SubagentResult): string {
	if (isFailed(result)) return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateForModel(text: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return text;

	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${bytes - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

async function writeSystemPrompt(): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const file = path.join(dir, "system-prompt.md");
	await fs.promises.writeFile(
		file,
		[
			"You are a temporary child pi session for one delegated task.",
			"This is not a named role agent. The user's task and supplied handoff context are the authority.",
			"Use only the minimum repository context needed, keep the result concise, and do not continue beyond the delegated task.",
			"Do not launch or propose subagents. Return findings, edits made, validation, and open risks when relevant.",
		].join("\n"),
		{ encoding: "utf8", mode: 0o600 },
	);
	return { dir, file };
}

function buildPrompt(config: Required<Pick<SubagentTaskConfig, "task" | "contextText">>): string {
	const parts = [];
	if (config.contextText.trim()) {
		parts.push(`Handoff context:\n${config.contextText.trim()}`);
	}
	parts.push(`Task:\n${config.task.trim()}`);
	return parts.join("\n\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function createForkSessionFile(ctx: ExtensionContext, index: number): string {
	const manager = ctx.sessionManager as any;
	const parentSessionFile = manager.getSessionFile?.();
	const leafId = manager.getLeafId?.();
	if (!parentSessionFile || !leafId) {
		throw new Error("Forked subagent context requires a persisted parent session and current leaf.");
	}

	const sessionDir = manager.getSessionDir?.();
	const source = typeof manager.openSession === "function"
		? manager.openSession(parentSessionFile, sessionDir)
		: SessionManager.open(parentSessionFile, sessionDir);
	const sessionFile = source.createBranchedSession(leafId);
	if (!sessionFile) throw new Error(`Failed to create forked session for child ${index + 1}.`);
	return sessionFile;
}

function appendToolArgs(args: string[], mode: ToolMode): void {
	if (mode === "none") {
		args.push("--no-tools");
		return;
	}
	const tools = mode === "write" ? ["read", "grep", "find", "ls", "bash", "edit", "write"] : ["read", "grep", "find", "ls"];
	args.push("--tools", tools.join(","));
}

function createPendingResult(index: number, config: ReturnType<typeof mergeConfig>): SubagentResult {
	return {
		index,
		task: config.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: config.model,
		thinking: config.thinking,
		context: config.context,
		tools: config.tools,
		cwd: config.cwd,
		durationMs: 0,
	};
}

function mergeConfig(
	defaults: {
		thinking: ThinkingLevel;
		model?: string;
		context: ContextMode;
		tools: ToolMode;
		contextText: string;
		cwd: string;
	},
	override: SubagentTaskConfig,
): {
	task: string;
	thinking: ThinkingLevel;
	model?: string;
	context: ContextMode;
	tools: ToolMode;
	contextText: string;
	cwd: string;
} {
	const parsedModel = splitModelThinking(override.model ?? defaults.model);
	return {
		task: override.task,
		thinking: override.thinking ?? splitModelThinking(override.model).thinking ?? defaults.thinking,
		model: parsedModel.model,
		context: override.context ?? defaults.context,
		tools: override.tools ?? defaults.tools,
		contextText: override.contextText ?? defaults.contextText,
		cwd: override.cwd ?? defaults.cwd,
	};
}

async function runSubagent(
	ctx: ExtensionContext,
	index: number,
	config: ReturnType<typeof mergeConfig>,
	signal: AbortSignal | undefined,
	onUpdate: ((result: SubagentResult) => void) | undefined,
): Promise<SubagentResult> {
	const startedAt = Date.now();
	const modelArg = config.model;
	const result: SubagentResult = {
		index,
		task: config.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: config.model,
		thinking: config.thinking,
		context: config.context,
		tools: config.tools,
		cwd: config.cwd,
		durationMs: 0,
	};

	let promptTemp: { dir: string; file: string } | undefined;
	try {
		promptTemp = await writeSystemPrompt();
		const args = ["--mode", "json", "-p", "--no-extensions", "--no-skills", "--append-system-prompt", promptTemp.file];
		if (modelArg) args.push("--model", modelArg);
		args.push("--thinking", config.thinking);
		appendToolArgs(args, config.tools);

		if (config.context === "fork") {
			const sessionFile = createForkSessionFile(ctx, index);
			result.sessionFile = sessionFile;
			args.push("--session", sessionFile);
		} else {
			args.push("--no-session");
		}

		args.push(buildPrompt({ task: config.task, contextText: config.contextText }));

		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: config.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					result.messages.push(message);
					if (message.role === "assistant") {
						result.usage.turns++;
						const usage = (message as any).usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
						}
						if (!result.model && (message as any).model) result.model = (message as any).model;
						if ((message as any).stopReason) result.stopReason = (message as any).stopReason;
						if ((message as any).errorMessage) result.errorMessage = (message as any).errorMessage;
					}
					onUpdate?.({ ...result, durationMs: Date.now() - startedAt });
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal?.aborted) killProc();
			else signal?.addEventListener("abort", killProc, { once: true });
		});

		result.exitCode = wasAborted ? 130 : exitCode;
		result.durationMs = Date.now() - startedAt;
		if (wasAborted) result.stopReason = "aborted";
		return result;
	} catch (error) {
		result.exitCode = 1;
		result.durationMs = Date.now() - startedAt;
		result.errorMessage = error instanceof Error ? error.message : String(error);
		return result;
	} finally {
		if (promptTemp) await fs.promises.rm(promptTemp.dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = new Array(Math.min(Math.max(1, concurrency), items.length)).fill(null).map(async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

function formatUsage(usage: UsageStats): string {
	const parts = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`in ${usage.input}`);
	if (usage.output) parts.push(`out ${usage.output}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" · ");
}

function makeDetails(mode: "single" | "parallel", results: SubagentResult[]): SubagentDetails {
	return { mode, results };
}

export default function subagentExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run generic child pi session(s) for clean context management. No named roles or agent registry; choose context, model, thinking, and tool mode per task.",
		promptSnippet: "Launch generic child pi sessions with selected thinking level and fresh/forked context.",
		promptGuidelines: [
			"Use subagent when a clean child context would help, or when independent read-only work can run in parallel.",
			"For subagent, prefer context=fresh and the lowest thinking level that can handle the work; use tools=write only for explicitly delegated edits.",
			`For subagent tasks that are simple information extraction, file inventories, exact lookups, or mechanical summarization without judgement, prefer model=${SIMPLE_EXTRACTION_MODEL} with minimal/low thinking instead of inheriting an expensive parent model.`,
			"For subagent, inherit the parent model or choose a stronger child model for coding, design review, debugging, ambiguous research, synthesis, or decisions with risk.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate: OnUpdate, ctx): Promise<ToolResult> {
			const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
			const hasParallel = Array.isArray(params.tasks) && params.tasks.length > 0;
			if (Number(hasSingle) + Number(hasParallel) !== 1) {
				return {
					content: [{ type: "text", text: "Invalid subagent call: provide exactly one of task or tasks." }],
					details: makeDetails("single", []),
					isError: true,
				};
			}

			const defaultModel = splitModelThinking(params.model ?? currentModel(ctx));
			const defaults = {
				thinking: (params.thinking as ThinkingLevel | undefined) ?? defaultModel.thinking ?? currentThinking(pi),
				model: defaultModel.model,
				context: (params.context as ContextMode | undefined) ?? "fresh",
				tools: (params.tools as ToolMode | undefined) ?? "read-only",
				contextText: params.contextText ?? "",
				cwd: params.cwd ?? ctx.cwd,
			};
			const maxOutputBytes = params.maxOutputBytes ?? 20_000;

			if (hasSingle) {
				const config = mergeConfig(defaults, { task: params.task!, contextText: params.contextText });
				const result = await runSubagent(ctx, 0, config, signal, (partial) => {
					onUpdate?.({
						content: [{ type: "text", text: truncateForModel(getFinalOutput(partial.messages) || "Subagent running…", maxOutputBytes) }],
						details: makeDetails("single", [partial]),
					});
				});
				return {
					content: [{ type: "text", text: truncateForModel(resultOutput(result), maxOutputBytes) }],
					details: makeDetails("single", [result]),
					...(isFailed(result) ? { isError: true } : {}),
				};
			}

			const tasks = params.tasks as SubagentTaskConfig[];
			if (tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many child sessions: ${tasks.length}. Max is ${MAX_PARALLEL_TASKS}.` }],
					details: makeDetails("parallel", []),
					isError: true,
				};
			}
			if (tasks.some((task) => task.task.trim().length === 0)) {
				return {
					content: [{ type: "text", text: "Invalid subagent call: every parallel task must include non-empty work." }],
					details: makeDetails("parallel", []),
					isError: true,
				};
			}

			const configs = tasks.map((task) => mergeConfig(defaults, task));
			const partials: SubagentResult[] = configs.map((config, index) => createPendingResult(index, config));
			const emitProgress = () => {
				const done = partials.filter((item) => item.exitCode !== -1).length;
				onUpdate?.({
					content: [{ type: "text", text: `Subagents: ${done}/${tasks.length} done` }],
					details: makeDetails("parallel", partials.map((item) => ({ ...item }))),
				});
			};

			const results = await mapWithConcurrency(configs, params.concurrency ?? DEFAULT_CONCURRENCY, async (config, index) => {
				const result = await runSubagent(ctx, index, config, signal, (partial) => {
					partials[index] = partial;
					emitProgress();
				});
				partials[index] = result;
				emitProgress();
				return result;
			});

			const successCount = results.filter((result) => !isFailed(result)).length;
			const summaries = results.map((result) => {
				const status = isFailed(result) ? "failed" : "completed";
				const usage = formatUsage(result.usage);
				const meta = [`thinking ${result.thinking}`, result.model, usage].filter(Boolean).join(" · ");
				return `### Subagent ${result.index + 1} ${status}${meta ? ` (${meta})` : ""}\n\n${truncateForModel(resultOutput(result), maxOutputBytes)}`;
			});

			return {
				content: [{ type: "text", text: `Subagents: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
				details: makeDetails("parallel", results),
				...(successCount === results.length ? {} : { isError: true }),
			};
		},

		renderCall(args, theme) {
			if (args.tasks?.length) {
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
						theme.fg("accent", `parallel ${args.tasks.length}`) +
						theme.fg("muted", ` · thinking ${args.thinking ?? "inherit"} · ${args.context ?? "fresh"}`),
					0,
					0,
				);
			}
			const preview = args.task ? (args.task.length > 80 ? `${args.task.slice(0, 80)}…` : args.task) : "…";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("muted", `thinking ${args.thinking ?? "inherit"} · ${args.context ?? "fresh"}\n`) +
					theme.fg("dim", preview),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details?.results?.length) {
				const content = result.content[0];
				return new Text(content?.type === "text" ? content.text : "(no output)", 0, 0);
			}
			const lines = details.results.map((item) => {
				const status = subagentStatus(item);
				const mark = status === "running" ? theme.fg("warning", "…") : status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const usage = formatUsage(item.usage);
				const meta = [`thinking ${item.thinking}`, item.model, usage].filter(Boolean).join(" · ");
				return `${mark} subagent ${item.index + 1}${meta ? theme.fg("dim", ` · ${meta}`) : ""}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
