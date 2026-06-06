import test from "node:test";
import assert from "node:assert/strict";
import {
	FAST_MODE_STATE_ENTRY_TYPE,
	getDefaultFastModeEnabled,
	getFastSupportForModel,
	isFastModeRequested,
	parseFastModeModel,
	patchPayloadWithFastMode,
	restoreFastModeState,
} from "../extensions/shared/fast-mode.ts";

function ctxWithEntries(entries, model) {
	return {
		model,
		sessionManager: {
			getEntries: () => entries,
		},
	};
}

test("fast support follows the shared provider/model allowlist", () => {
	assert.equal(getFastSupportForModel(parseFastModeModel("openai-codex/gpt-5.5")).supported, true);
	assert.equal(getFastSupportForModel(parseFastModeModel("anthropic/claude-sonnet-4.5")).supported, false);
	assert.equal(getFastSupportForModel(parseFastModeModel("openai-codex/not-real")).supported, false);
});

test("fast mode state restores the latest persisted preference", () => {
	const ctx = ctxWithEntries([
		{ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: false, explicit: true } },
		{ type: "custom", customType: "other", data: { enabled: true } },
		{ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: true, explicit: true } },
	]);

	assert.deepEqual(restoreFastModeState(ctx), { enabled: true, explicit: true });
	assert.equal(isFastModeRequested(ctx), true);
});

// Fast mode is opt-out: supported models request it unless a persisted session
// preference says otherwise.
test("fast mode defaults on only for supported models", () => {
	const supportedCtx = ctxWithEntries([], { provider: "openai-codex", id: "gpt-5.5" });
	const unsupportedCtx = ctxWithEntries([], { provider: "anthropic", id: "claude-sonnet-4.5" });
	const explicitOffCtx = ctxWithEntries(
		[{ type: "custom", customType: FAST_MODE_STATE_ENTRY_TYPE, data: { enabled: false, explicit: true } }],
		{ provider: "openai-codex", id: "gpt-5.5" },
	);

	assert.equal(getDefaultFastModeEnabled(supportedCtx), true);
	assert.equal(isFastModeRequested(supportedCtx), true);
	assert.equal(getDefaultFastModeEnabled(unsupportedCtx), false);
	assert.equal(isFastModeRequested(unsupportedCtx), false);
	assert.equal(getDefaultFastModeEnabled(explicitOffCtx), true);
	assert.equal(isFastModeRequested(explicitOffCtx), false);
});

test("fast payload patch only adds priority service tier to object payloads", () => {
	assert.deepEqual(patchPayloadWithFastMode({ model: "gpt-5.5" }), { model: "gpt-5.5", service_tier: "priority" });
	assert.equal(patchPayloadWithFastMode(null), null);
	const arrayPayload = [];
	assert.equal(patchPayloadWithFastMode(arrayPayload), arrayPayload);
});
