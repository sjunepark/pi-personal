import test from "node:test";
import assert from "node:assert/strict";
import { AgentCompactionController } from "../extensions/agent-compaction.ts";

function createHarness() {
	const sentMessages = [];
	const appendedEntries = [];
	const pi = {
		appendEntry(type, data) {
			appendedEntries.push({ type, data });
		},
		sendMessage(message, options) {
			sentMessages.push({ message, options });
		},
	};
	const ctx = {
		hasUI: false,
		getContextUsage() {
			return { percent: 50, tokens: 1000, contextWindow: 2000 };
		},
		isIdle() {
			return true;
		},
		compact(options) {
			options.onComplete({ tokensBefore: 1000 });
		},
	};

	return { controller: new AgentCompactionController(), pi, ctx, sentMessages, appendedEntries };
}

async function waitForSentMessage(sentMessages, count) {
	const deadline = Date.now() + 500;
	while (sentMessages.length < count && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(sentMessages.length, count);
}

test("announce-and-stop compaction reports completion without triggering continuation", async () => {
	const { controller, pi, ctx, sentMessages } = createHarness();

	controller.request(pi, ctx, {
		source: "compact-custom",
		message: "Please compact now.",
		completionBehavior: "announce-and-stop",
	});
	await waitForSentMessage(sentMessages, 1);
	sentMessages.length = 0;

	const result = controller.acceptCompaction(pi, ctx, "Compacted working context");
	assert.equal(result.terminate, true);
	assert.match(result.content[0].text, /wait for the human user's next message/);

	controller.runAfterAgent(pi, ctx);
	await waitForSentMessage(sentMessages, 1);

	assert.equal(sentMessages[0].options.triggerTurn, false);
	assert.match(sentMessages[0].message.content, /Stop here/);
});

test("default compaction completion still triggers continuation", async () => {
	const { controller, pi, ctx, sentMessages } = createHarness();

	controller.request(pi, ctx, {
		source: "workflow",
		message: "Please compact before continuing.",
	});
	await waitForSentMessage(sentMessages, 1);
	sentMessages.length = 0;

	const result = controller.acceptCompaction(pi, ctx, "Compacted working context");
	assert.equal(result.terminate, true);
	assert.match(result.content[0].text, /continue automatically/);

	controller.runAfterAgent(pi, ctx);
	await waitForSentMessage(sentMessages, 1);

	assert.equal(sentMessages[0].options.triggerTurn, true);
	assert.match(sentMessages[0].message.content, /Continue the user's task/);
});
