import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	activateNestedAgentsForPath,
	createNestedAgentsState,
	findGitRoot,
	getOrderedActiveInstructions,
	getToolPathInput,
	hasGuidanceMessageInBranch,
	isRelevantFileTool,
	NESTED_AGENTS_CONTEXT_MESSAGE_TYPE,
	NESTED_AGENTS_GUIDANCE,
	NESTED_AGENTS_GUIDANCE_MESSAGE_TYPE,
	normalizeKnownContextFiles,
	refreshActiveInstructions,
	renderActiveInstructions,
	withoutNestedAgentsContextMessages,
} from "./shared/nested-agents.js";

export default function nestedAgents(pi: ExtensionAPI): void {
	const state = createNestedAgentsState();

	function resetForSession(ctx: ExtensionContext): void {
		state.loadedContextFiles = new Set();
		state.contentCache = new Map();
		state.activeInstructions = new Map();

		const projectRoot = findGitRoot(ctx.cwd);
		if (!projectRoot) {
			state.projectRoot = undefined;
			state.inactiveReason = "not inside a git worktree";
			return;
		}

		state.projectRoot = projectRoot;
		state.inactiveReason = undefined;
	}

	function ensureGuidanceMessage(ctx: ExtensionContext): void {
		if (hasGuidanceMessageInBranch(ctx.sessionManager.getBranch())) return;
		pi.sendMessage({
			customType: NESTED_AGENTS_GUIDANCE_MESSAGE_TYPE,
			content: NESTED_AGENTS_GUIDANCE,
			display: false,
			details: { source: "nested-agents-extension" },
		});
	}

	pi.on("session_start", (_event, ctx) => {
		resetForSession(ctx);
		ensureGuidanceMessage(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		ensureGuidanceMessage(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		state.loadedContextFiles = normalizeKnownContextFiles(event.systemPromptOptions.contextFiles);
		ensureGuidanceMessage(ctx);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isRelevantFileTool(event.toolName)) return;

		const toolPath = getToolPathInput(event.input);
		if (!toolPath) return;

		activateNestedAgentsForPath(state, toolPath, ctx.cwd);
	});

	pi.on("context", (event) => {
		refreshActiveInstructions(state);

		const baseMessages = withoutNestedAgentsContextMessages(event.messages as Array<{ customType?: string }>);
		const content = renderActiveInstructions(getOrderedActiveInstructions(state));
		if (!content) return { messages: baseMessages as any };

		return {
			messages: [
				...baseMessages,
				{
					role: "custom",
					customType: NESTED_AGENTS_CONTEXT_MESSAGE_TYPE,
					content,
					display: false,
					details: {
						source: "nested-agents-extension",
						paths: getOrderedActiveInstructions(state).map((instruction) => instruction.path),
					},
					timestamp: Date.now(),
				},
			] as any,
		};
	});

	pi.registerCommand("nested-agents", {
		description: "Show active nested AGENTS.md instruction files",
		handler: async (_args, ctx) => {
			state.loadedContextFiles = normalizeKnownContextFiles(ctx.getSystemPromptOptions().contextFiles);
			refreshActiveInstructions(state);
			ctx.ui.notify(formatStatus(), "info");
		},
	});

	function formatStatus(): string {
		const activeInstructions = getOrderedActiveInstructions(state);
		const lines = ["Nested AGENTS.md extension"];

		if (!state.projectRoot) {
			lines.push(`status: inactive (${state.inactiveReason ?? "unknown reason"})`);
			return lines.join("\n");
		}

		lines.push(`git root: ${state.projectRoot}`);
		lines.push(`startup context files excluded: ${state.loadedContextFiles.size}`);

		if (activeInstructions.length === 0) {
			lines.push("active instruction files: none");
			return lines.join("\n");
		}

		lines.push("active instruction files:");
		for (const instruction of activeInstructions) {
			lines.push(`- ${instruction.path}`);
			lines.push(`  first trigger: ${instruction.firstTriggerPath}`);
			lines.push(`  latest trigger: ${instruction.latestTriggerPath}`);
		}

		return lines.join("\n");
	}
}
