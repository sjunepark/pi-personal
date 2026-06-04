import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";

const iso = "2026-01-01T00:00:00.000Z";
const now = Date.parse(iso);

function userEntry(id, parentId, content) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: iso,
		message: {
			role: "user",
			content,
			timestamp: now,
		},
	};
}

function assistantEntry(id, parentId, text) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: iso,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test-model",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		},
	};
}

function compactionEntry(id, parentId, firstKeptEntryId) {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: iso,
		summary: "agent-authored compacted context",
		firstKeptEntryId,
		tokensBefore: 1234,
		fromHook: true,
		details: { source: "context-compaction-guard-state", fullReplacement: true },
	};
}

test("fake firstKeptEntryId produces full-replacement compaction context", () => {
	const entries = [
		userEntry("u1", null, "before user message"),
		assistantEntry("a1", "u1", "before assistant message"),
		compactionEntry("c1", "a1", "context-compaction-guard:no-kept-entry:test"),
		userEntry("u2", "c1", "after user message"),
	];

	const context = buildSessionContext(entries);

	assert.deepEqual(
		context.messages.map((message) => message.role),
		["compactionSummary", "user"],
	);
	assert.equal(context.messages[0].summary, "agent-authored compacted context");
	assert.equal(context.messages[1].content, "after user message");
	assert.equal(
		context.messages.some((message) => JSON.stringify(message).includes("before")),
		false,
		"messages before the compaction entry must not remain in context when firstKeptEntryId is missing",
	);
});

test("real firstKeptEntryId keeps the documented recent tail", () => {
	const entries = [
		userEntry("u1", null, "discarded user message"),
		assistantEntry("a1", "u1", "discarded assistant message"),
		userEntry("u2", "a1", "kept user message"),
		assistantEntry("a2", "u2", "kept assistant message"),
		compactionEntry("c1", "a2", "u2"),
		userEntry("u3", "c1", "after user message"),
	];

	const context = buildSessionContext(entries);

	assert.deepEqual(
		context.messages.map((message) => message.role),
		["compactionSummary", "user", "assistant", "user"],
	);
	assert.equal(context.messages[1].content, "kept user message");
	assert.equal(context.messages[2].content[0].text, "kept assistant message");
	assert.equal(context.messages[3].content, "after user message");
	assert.equal(
		context.messages.some((message) => JSON.stringify(message).includes("discarded")),
		false,
		"messages before the real firstKeptEntryId should be compacted away",
	);
});
