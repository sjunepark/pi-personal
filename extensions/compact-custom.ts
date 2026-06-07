import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { agentCompaction } from "./agent-compaction.js";
import { buildManualCompactionRequestMessage } from "./shared/agent-compaction-prompts.js";

export default function compactCustom(pi: ExtensionAPI): void {
	agentCompaction.register(pi);

	pi.registerCommand("compact-custom", {
		description: "Request agent-authored high-fidelity context compaction",
		getArgumentCompletions(prefix) {
			if (prefix.trim()) return null;
			return [
				"focus on current task state and exact file snippets",
				"preserve validation results, pending edits, and next actions",
				"keep only details needed to continue without rereading files",
			].map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const customInstructions = args.trim() || undefined;
			const usage = ctx.getContextUsage();
			const ok = agentCompaction.request(pi, ctx, {
				source: "compact-custom",
				message: buildManualCompactionRequestMessage({ usage, customInstructions }),
				details: { customInstructions, usage },
				completionBehavior: "announce-and-stop",
			});

			if (!ok && ctx.hasUI) {
				ctx.ui.notify("A context compaction request is already active", "warning");
			}
		},
	});
}
