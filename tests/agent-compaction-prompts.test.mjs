import test from "node:test";
import assert from "node:assert/strict";
import {
	buildManualCompactionRequestMessage,
	buildThresholdCompactionAdvisory,
	formatContextUsage,
} from "../extensions/shared/agent-compaction-prompts.ts";

test("manual compaction prompt carries user focus and requires compact_conversation", () => {
	const message = buildManualCompactionRequestMessage({
		usage: { percent: 51.234, tokens: 12345, contextWindow: 200000 },
		customInstructions: "preserve exact validation output",
	});

	assert.match(message, /Manual agent-authored context compaction requested/);
	assert.match(message, /51\.2% \(12,345 tokens \/ 200,000\)/);
	assert.match(message, /Before continuing, call compact_conversation/);
	assert.match(message, /preserve exact validation output/);
	assert.match(message, /## Files and code already inspected/);
});

test("threshold advisory is optional but names compact_conversation when accepted", () => {
	const message = buildThresholdCompactionAdvisory({ threshold: 70, usageLabel: "70.0%", urgent: true });

	assert.match(message, /Urgency: HIGH/);
	assert.match(message, /Decide automatically whether to compact/);
	assert.match(message, /If you choose to compact, call compact_conversation/);
	assert.match(message, /If you choose not to compact, silently continue/);
});

test("context usage formatter handles unknown usage", () => {
	assert.equal(formatContextUsage(undefined), "context usage unavailable");
	assert.equal(formatContextUsage({ percent: null, tokens: null, contextWindow: 1000 }), "unknown (unknown tokens / 1,000)");
});
