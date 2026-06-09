import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	activateNestedAgentsForPath,
	createNestedAgentsState,
	discoverAgentsFiles,
	hasGuidanceMessageInBranch,
	NESTED_AGENTS_CONTEXT_MESSAGE_TYPE,
	NESTED_AGENTS_GUIDANCE_MESSAGE_TYPE,
	refreshActiveInstructions,
	renderActiveInstructions,
	resolveTargetDirectory,
	withoutNestedAgentsContextMessages,
} from "../extensions/shared/nested-agents.ts";

function makeTempRepo() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "nested-agents-"));
}

test("target path resolution strips @, rejects outside paths, and ignores noisy directories", () => {
	const root = makeTempRepo();
	fs.mkdirSync(path.join(root, "packages", "web", "src"), { recursive: true });
	fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
	fs.writeFileSync(path.join(root, "packages", "web", "src", "Button.svelte"), "");

	const resolved = resolveTargetDirectory("@packages/web/src/Button.svelte", root, root);
	assert.deepEqual(resolved, {
		targetPath: path.join(root, "packages", "web", "src", "Button.svelte"),
		targetDirectory: path.join(root, "packages", "web", "src"),
	});

	assert.equal(resolveTargetDirectory("../outside.ts", root, root), undefined);
	assert.equal(resolveTargetDirectory("node_modules/pkg/index.js", root, root), undefined);
});

test("AGENTS.md discovery walks broad-to-local and excludes startup-loaded context files", () => {
	const root = makeTempRepo();
	const web = path.join(root, "packages", "web");
	const src = path.join(web, "src");
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(root, "AGENTS.md"), "root rules");
	fs.writeFileSync(path.join(web, "AGENTS.md"), "web rules");
	fs.writeFileSync(path.join(src, "AGENTS.MD"), "src rules");

	assert.deepEqual(discoverAgentsFiles(root, src), [
		path.join(root, "AGENTS.md"),
		path.join(web, "AGENTS.md"),
		path.join(src, "AGENTS.MD"),
	]);

	assert.deepEqual(discoverAgentsFiles(root, src, new Set([path.join(root, "AGENTS.md")])), [
		path.join(web, "AGENTS.md"),
		path.join(src, "AGENTS.MD"),
	]);
});

test("activation is cumulative and active instruction content refreshes by mtime", async () => {
	const root = makeTempRepo();
	const web = path.join(root, "packages", "web");
	const api = path.join(root, "packages", "api");
	fs.mkdirSync(path.join(web, "src"), { recursive: true });
	fs.mkdirSync(path.join(api, "src"), { recursive: true });
	fs.writeFileSync(path.join(web, "AGENTS.md"), "web rules v1");
	fs.writeFileSync(path.join(api, "AGENTS.md"), "api rules");

	const state = createNestedAgentsState();
	state.projectRoot = root;

	activateNestedAgentsForPath(state, "packages/web/src/Button.svelte", root);
	activateNestedAgentsForPath(state, "packages/api/src/server.ts", root);
	assert.deepEqual([...state.activeInstructions.keys()].sort(), [path.join(api, "AGENTS.md"), path.join(web, "AGENTS.md")].sort());

	await new Promise((resolve) => setTimeout(resolve, 10));
	fs.writeFileSync(path.join(web, "AGENTS.md"), "web rules v2");
	refreshActiveInstructions(state);

	const rendered = renderActiveInstructions([...state.activeInstructions.values()]);
	assert.match(rendered, /web rules v2/);
	assert.match(rendered, /api rules/);
});

test("guidance and context helpers identify extension-owned messages", () => {
	assert.equal(
		hasGuidanceMessageInBranch([{ type: "custom_message", customType: NESTED_AGENTS_GUIDANCE_MESSAGE_TYPE }]),
		true,
	);
	assert.deepEqual(
		withoutNestedAgentsContextMessages([
			{ role: "user", content: "keep" },
			{ role: "custom", customType: NESTED_AGENTS_CONTEXT_MESSAGE_TYPE, content: "drop" },
		]),
		[{ role: "user", content: "keep" }],
	);
});
