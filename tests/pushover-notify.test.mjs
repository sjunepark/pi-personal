import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pushoverNotify from "../extensions/pushover-notify.ts";

function assistantMessage(text = "Done") {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function toolResultMessage(toolCallId, toolName, details) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

function messageEntry(message) {
	return { type: "message", id: message.toolCallId ?? "assistant", message };
}

function createHarness(branchEntries = []) {
	const handlers = new Map();
	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand() {},
		exec: async () => ({ killed: false, code: 1, stdout: "", stderr: "" }),
	};
	const ctx = {
		hasUI: false,
		sessionManager: {
			getBranch: () => branchEntries,
		},
	};
	pushoverNotify(pi);
	return {
		async emit(event, payload = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

function configurePushover(t) {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;
	const requests = [];
	process.env.PUSHOVER_APP_TOKEN = "token";
	process.env.PUSHOVER_USER_KEY = "user";
	process.env.PI_PUSHOVER_MIN_MS = "0";
	process.env.PI_PUSHOVER_DEBOUNCE_MS = "0";
	process.env.PI_PUSHOVER_STATE_FILE = join(tmpdir(), `pi-pushover-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
	delete process.env.CMUX_WORKSPACE_ID;
	globalThis.fetch = async (url, init) => {
		requests.push({ url, init });
		return { ok: true, text: async () => "" };
	};
	t.after(() => {
		process.env = originalEnv;
		globalThis.fetch = originalFetch;
	});
	return requests;
}

function requestMessage(request) {
	return request.init.body.get("message");
}

test("completion notifications include a truncated assistant response preview", async (t) => {
	const requests = configurePushover(t);
	const longOutput = `Final answer: ${"x".repeat(1200)}`;
	const harness = createHarness();

	await harness.emit("agent_start");
	await harness.emit("agent_end", { messages: [assistantMessage(longOutput)] });

	assert.equal(requests.length, 1);
	const message = requestMessage(requests[0]);
	assert.match(message, /^Ready for your next prompt\n\nFinal answer: /);
	assert.ok(message.length <= 1024);
	assert.match(message, /\.\.\.$/);
});

test("historical notify-suppressed tool results do not suppress a later completion", async (t) => {
	const requests = configurePushover(t);
	const previousToolResult = toolResultMessage("previous", "post_review_loop_submit_phase_result", {
		notify: { suppressCompletion: true },
	});
	const harness = createHarness([messageEntry(previousToolResult)]);

	await harness.emit("agent_start");
	await harness.emit("agent_end", { messages: [previousToolResult, assistantMessage()] });

	assert.equal(requests.length, 1);
});

test("new compact_conversation tool results suppress completion notifications", async (t) => {
	const requests = configurePushover(t);
	const harness = createHarness();

	await harness.emit("agent_start");
	await harness.emit("agent_end", { messages: [toolResultMessage("compact", "compact_conversation"), assistantMessage()] });

	assert.equal(requests.length, 0);
});

test("notify control from the current tool_result event suppresses completion notifications", async (t) => {
	const requests = configurePushover(t);
	const harness = createHarness();

	await harness.emit("agent_start");
	await harness.emit("tool_result", {
		type: "tool_result",
		toolCallId: "phase-result",
		toolName: "post_review_loop_submit_phase_result",
		input: {},
		content: [],
		isError: false,
		details: { notify: { suppressCompletion: true } },
	});
	await harness.emit("agent_end", { messages: [assistantMessage()] });

	assert.equal(requests.length, 0);
});
