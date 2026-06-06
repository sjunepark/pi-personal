import test from "node:test";
import assert from "node:assert/strict";
import {
	FAST_MODE_STATE_ENTRY_TYPE,
	getFastSupportForModel,
	isFastModeRequested,
	parseFastModeModel,
	patchPayloadWithFastMode,
	restoreFastModeState,
} from "../extensions/shared/fast-mode.ts";

function ctxWithEntries(entries) {
	return {
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

test("fast payload patch only adds priority service tier to object payloads", () => {
	assert.deepEqual(patchPayloadWithFastMode({ model: "gpt-5.5" }), { model: "gpt-5.5", service_tier: "priority" });
	assert.equal(patchPayloadWithFastMode(null), null);
	const arrayPayload = [];
	assert.equal(patchPayloadWithFastMode(arrayPayload), arrayPayload);
});
