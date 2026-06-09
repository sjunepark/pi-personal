import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const NESTED_AGENTS_GUIDANCE_MESSAGE_TYPE = "nested-agents-extension-guidance";
export const NESTED_AGENTS_CONTEXT_MESSAGE_TYPE = "nested-agents-active-instructions";

export const NESTED_AGENTS_GUIDANCE = `<nested_agents_extension_guidance>
Nested AGENTS.md loading is cumulative in the main session. Use read-only subagents for exploratory inspection of unrelated modules when the main thread does not need to edit or deeply reason about those files. If the main thread will act on a module, read/touch the relevant path in the main thread so scoped instructions are loaded. Subagent-loaded instructions do not automatically transfer back.
</nested_agents_extension_guidance>`;

const AGENTS_FILE_NAMES = ["AGENTS.md", "AGENTS.MD"] as const;
const IGNORED_SEGMENTS = new Set([
	".git",
	"node_modules",
	".tmp",
	"out",
	"dist",
	"build",
	"coverage",
	".cache",
	"cache",
	"caches",
	".next",
	".svelte-kit",
]);

export type CachedInstruction = {
	path: string;
	content: string;
	mtimeMs: number;
};

export type ActiveInstruction = CachedInstruction & {
	firstTriggerPath: string;
	latestTriggerPath: string;
	loadedAt: number;
};

export type NestedAgentsState = {
	projectRoot?: string;
	inactiveReason?: string;
	loadedContextFiles: Set<string>;
	contentCache: Map<string, CachedInstruction>;
	activeInstructions: Map<string, ActiveInstruction>;
};

export type ActivationResult = {
	targetPath?: string;
	targetDirectory?: string;
	activated: string[];
	ignoredReason?: string;
};

export function createNestedAgentsState(): NestedAgentsState {
	return {
		loadedContextFiles: new Set(),
		contentCache: new Map(),
		activeInstructions: new Map(),
	};
}

export function findGitRoot(cwd: string): string | undefined {
	try {
		const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
		}).trim();
		return output ? path.resolve(output) : undefined;
	} catch {
		return undefined;
	}
}

export function normalizeKnownContextFiles(files: Array<{ path: string }> | undefined): Set<string> {
	return new Set((files ?? []).map((file) => normalizeAbsolutePath(file.path)));
}

export function hasGuidanceMessageInBranch(entries: Array<Record<string, unknown>>): boolean {
	return entries.some((entry) => entry.type === "custom_message" && entry.customType === NESTED_AGENTS_GUIDANCE_MESSAGE_TYPE);
}

export function isRelevantFileTool(toolName: string): toolName is "read" | "edit" | "write" {
	return toolName === "read" || toolName === "edit" || toolName === "write";
}

export function getToolPathInput(input: Record<string, unknown>): string | undefined {
	return typeof input.path === "string" && input.path.trim() ? input.path : undefined;
}

export function resolveTargetDirectory(rawPath: string, cwd: string, projectRoot: string): { targetPath: string; targetDirectory: string } | undefined {
	const strippedPath = stripLeadingAt(rawPath.trim());
	if (!strippedPath) return undefined;

	const targetPath = path.resolve(cwd, strippedPath);
	const normalizedRoot = normalizeAbsolutePath(projectRoot);
	const normalizedTarget = normalizeAbsolutePath(targetPath);
	if (!isInsidePath(normalizedRoot, normalizedTarget)) return undefined;
	if (hasIgnoredSegment(normalizedRoot, normalizedTarget)) return undefined;

	let targetDirectory = normalizedTarget;
	try {
		const stat = fs.statSync(normalizedTarget);
		if (!stat.isDirectory()) targetDirectory = path.dirname(normalizedTarget);
	} catch {
		targetDirectory = path.dirname(normalizedTarget);
	}

	if (!isInsidePath(normalizedRoot, targetDirectory)) return undefined;
	if (hasIgnoredSegment(normalizedRoot, targetDirectory)) return undefined;

	return { targetPath: normalizedTarget, targetDirectory };
}

export function discoverAgentsFiles(projectRoot: string, targetDirectory: string, loadedContextFiles: Set<string> = new Set()): string[] {
	const normalizedRoot = normalizeAbsolutePath(projectRoot);
	const normalizedTargetDirectory = normalizeAbsolutePath(targetDirectory);
	if (!isInsidePath(normalizedRoot, normalizedTargetDirectory)) return [];

	const realRoot = safeRealpath(normalizedRoot);
	if (!realRoot) return [];

	const directories = ancestorDirectories(normalizedRoot, normalizedTargetDirectory);
	const discovered: string[] = [];
	const seenFileIds = new Set<string>();
	const loadedFileIds = statFileIds(loadedContextFiles);

	for (const directory of directories) {
		for (const fileName of AGENTS_FILE_NAMES) {
			const candidate = normalizeAbsolutePath(path.join(directory, fileName));
			try {
				if (!directoryContainsExactName(directory, fileName)) continue;
				const stat = fs.statSync(candidate);
				if (!stat.isFile()) continue;
				const realCandidate = safeRealpath(candidate);
				if (!realCandidate || !isInsidePath(realRoot, realCandidate)) continue;
				const fileId = statFileId(stat);
				if (loadedContextFiles.has(candidate) || loadedFileIds.has(fileId) || seenFileIds.has(fileId)) continue;
				seenFileIds.add(fileId);
				discovered.push(candidate);
			} catch {
				// Missing candidates are expected for most directories.
			}
		}
	}

	return discovered;
}

export function readInstructionFile(filePath: string, cache: Map<string, CachedInstruction>, projectRoot: string): CachedInstruction | undefined {
	const normalizedPath = normalizeAbsolutePath(filePath);
	const realRoot = safeRealpath(projectRoot);
	if (!realRoot) return undefined;

	try {
		const stat = fs.statSync(normalizedPath);
		if (!stat.isFile()) return undefined;
		const realPath = safeRealpath(normalizedPath);
		if (!realPath || !isInsidePath(realRoot, realPath)) {
			cache.delete(normalizedPath);
			return undefined;
		}

		const cached = cache.get(normalizedPath);
		if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

		const instruction = {
			path: normalizedPath,
			content: fs.readFileSync(normalizedPath, "utf8"),
			mtimeMs: stat.mtimeMs,
		} satisfies CachedInstruction;
		cache.set(normalizedPath, instruction);
		return instruction;
	} catch {
		cache.delete(normalizedPath);
		return undefined;
	}
}

export function activateNestedAgentsForPath(state: NestedAgentsState, rawPath: string, cwd: string): ActivationResult {
	if (!state.projectRoot) {
		return { activated: [], ignoredReason: state.inactiveReason ?? "not inside a git worktree" };
	}

	const resolved = resolveTargetDirectory(rawPath, cwd, state.projectRoot);
	if (!resolved) {
		return { activated: [], ignoredReason: "path is outside the git root or under an ignored directory" };
	}

	const agentsFiles = discoverAgentsFiles(state.projectRoot, resolved.targetDirectory, state.loadedContextFiles);
	const activated: string[] = [];

	for (const agentsFile of agentsFiles) {
		const instruction = readInstructionFile(agentsFile, state.contentCache, state.projectRoot);
		if (!instruction) continue;

		const existing = state.activeInstructions.get(instruction.path);
		state.activeInstructions.set(instruction.path, {
			...instruction,
			firstTriggerPath: existing?.firstTriggerPath ?? resolved.targetPath,
			latestTriggerPath: resolved.targetPath,
			loadedAt: existing?.loadedAt ?? Date.now(),
		});
		activated.push(instruction.path);
	}

	return { targetPath: resolved.targetPath, targetDirectory: resolved.targetDirectory, activated };
}

export function refreshActiveInstructions(state: NestedAgentsState): void {
	if (!state.projectRoot) return;

	for (const [instructionPath, active] of Array.from(state.activeInstructions.entries())) {
		const refreshed = readInstructionFile(instructionPath, state.contentCache, state.projectRoot);
		if (!refreshed) {
			state.activeInstructions.delete(instructionPath);
			continue;
		}

		if (refreshed.content !== active.content || refreshed.mtimeMs !== active.mtimeMs) {
			state.activeInstructions.set(instructionPath, {
				...active,
				content: refreshed.content,
				mtimeMs: refreshed.mtimeMs,
			});
		}
	}
}

export function getOrderedActiveInstructions(state: NestedAgentsState): ActiveInstruction[] {
	const root = state.projectRoot;
	return Array.from(state.activeInstructions.values()).sort((a, b) => compareInstructionPaths(a.path, b.path, root));
}

export function renderActiveInstructions(instructions: ActiveInstruction[]): string | undefined {
	if (instructions.length === 0) return undefined;

	const blocks = instructions.map((instruction) => {
		return `<project_instructions path=${JSON.stringify(instruction.path)} first_trigger=${JSON.stringify(instruction.firstTriggerPath)} latest_trigger=${JSON.stringify(instruction.latestTriggerPath)}>
${instruction.content.trimEnd()}
</project_instructions>`;
	});

	return `<path_scoped_project_instructions source="nested-agents-extension" loading="cumulative">
These instructions were discovered from main-session file tool paths. Each block applies to files under its directory unless the file states a broader scope.

${blocks.join("\n\n")}
</path_scoped_project_instructions>`;
}

export function withoutNestedAgentsContextMessages<T extends { role?: string; customType?: string }>(messages: T[]): T[] {
	return messages.filter((message) => message.customType !== NESTED_AGENTS_CONTEXT_MESSAGE_TYPE);
}

function stripLeadingAt(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function normalizeAbsolutePath(value: string): string {
	return path.resolve(value);
}

function isInsidePath(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasIgnoredSegment(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	if (relative === "") return false;
	return relative.split(path.sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

function ancestorDirectories(root: string, targetDirectory: string): string[] {
	const relative = path.relative(root, targetDirectory);
	const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
	const directories = [root];
	let current = root;
	for (const part of parts) {
		current = path.join(current, part);
		directories.push(current);
	}
	return directories;
}

function directoryContainsExactName(directory: string, fileName: string): boolean {
	try {
		return fs.readdirSync(directory).includes(fileName);
	} catch {
		return false;
	}
}

function safeRealpath(filePath: string): string | undefined {
	try {
		return normalizeAbsolutePath(fs.realpathSync(filePath));
	} catch {
		return undefined;
	}
}

function statFileIds(paths: Set<string>): Set<string> {
	const ids = new Set<string>();
	for (const filePath of paths) {
		try {
			const stat = fs.statSync(filePath);
			if (stat.isFile()) ids.add(statFileId(stat));
		} catch {
			// Stale context-file paths are harmless.
		}
	}
	return ids;
}

function statFileId(stat: fs.Stats): string {
	return `${stat.dev}:${stat.ino}`;
}

function compareInstructionPaths(a: string, b: string, root: string | undefined): number {
	if (!root) return a.localeCompare(b);
	const aRelative = path.relative(root, a);
	const bRelative = path.relative(root, b);
	const aDepth = aRelative.split(path.sep).length;
	const bDepth = bRelative.split(path.sep).length;
	return aDepth - bDepth || aRelative.localeCompare(bRelative);
}
