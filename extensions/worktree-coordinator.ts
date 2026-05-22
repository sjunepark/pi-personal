import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const COMMAND_NAME = "wt";
const MESSAGE_TYPE = "worktree-coordinator-output";
const STATUS_KEY = "worktree-coordinator";
const STATE_VERSION = 1;
const STATE_RELATIVE_PATH = "pi-worktrees/state.json";
const COMMAND_TIMEOUT_MS = 10_000;
const STATE_LOCK_TIMEOUT_MS = 2_000;
const STATE_LOCK_RETRY_MS = 25;
const MAX_CONTEXT_ITEMS = 4;
const MAX_STATUS_FILES = 12;

type EntryStatus = "open" | "idle" | "stopped";

type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

type GitContext = {
	cwd: string;
	repoRoot: string;
	commonDir: string;
	statePath: string;
	worktreePath: string;
	branch: string;
};

type WorktreeInfo = {
	path: string;
	branch?: string;
	head?: string;
	detached?: boolean;
	bare?: boolean;
};

type WorktreeEntry = {
	worktreePath: string;
	repoRoot: string;
	branch: string;
	sessionFile?: string;
	intent: string;
	implementationArea?: string;
	status: EntryStatus;
	dirtyFiles: string[];
	dirtyFileCount: number;
	startedAt: number;
	updatedAt: number;
	lastSeenAt: number;
};

type CoordinatorState = {
	version: 1;
	worktrees: Record<string, WorktreeEntry>;
};

type ParsedCommand = {
	action: string;
	body: string;
};

function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, kind);
}

function sendOutput(pi: ExtensionAPI, title: string, body: string): void {
	pi.sendMessage({
		customType: MESSAGE_TYPE,
		content: title,
		display: true,
		details: { body },
	});
}

function now(): number {
	return Date.now();
}

function compactPath(path: string, repoRoot: string): string {
	const relative = path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;
	return relative || path;
}

function formatAge(timestamp: number | undefined): string {
	if (!timestamp) return "unknown";
	const elapsed = Math.max(0, Date.now() - timestamp);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function truncateLine(value: string, max = 180): string {
	const trimmed = value.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1)}…`;
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<ExecResult> {
	return await pi.exec("git", ["-C", cwd, ...args], { timeout });
}

async function getGitContext(pi: ExtensionAPI, ctx: ExtensionContext): Promise<GitContext | undefined> {
	const cwd = ctx.cwd;
	const repoRootResult = await runGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
	const repoRoot = repoRootResult.stdout.trim();
	if (repoRootResult.code !== 0 || !repoRoot) return undefined;

	const commonDirResult = await runGit(pi, cwd, ["rev-parse", "--git-common-dir"]);
	const rawCommonDir = commonDirResult.stdout.trim();
	if (commonDirResult.code !== 0 || !rawCommonDir) return undefined;
	const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(cwd, rawCommonDir);

	const branchResult = await runGit(pi, cwd, ["branch", "--show-current"]);
	let branch = branchResult.stdout.trim();
	if (!branch) {
		const headResult = await runGit(pi, cwd, ["rev-parse", "--short", "HEAD"]);
		branch = headResult.stdout.trim() ? `detached:${headResult.stdout.trim()}` : "unknown";
	}

	return {
		cwd,
		repoRoot,
		commonDir,
		statePath: join(commonDir, STATE_RELATIVE_PATH),
		worktreePath: repoRoot,
		branch,
	};
}

function emptyState(): CoordinatorState {
	return { version: STATE_VERSION, worktrees: {} };
}

function normalizeEntry(input: WorktreeEntry): WorktreeEntry {
	return {
		...input,
		status: input.status ?? "idle",
		dirtyFiles: Array.isArray(input.dirtyFiles) ? input.dirtyFiles : [],
		dirtyFileCount: Number.isFinite(input.dirtyFileCount) ? input.dirtyFileCount : 0,
	};
}

function readState(statePath: string): CoordinatorState {
	try {
		if (!existsSync(statePath)) return emptyState();
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<CoordinatorState>;
		if (parsed.version !== STATE_VERSION || !parsed.worktrees || typeof parsed.worktrees !== "object") return emptyState();
		return {
			version: STATE_VERSION,
			worktrees: Object.fromEntries(Object.entries(parsed.worktrees).map(([key, entry]) => [key, normalizeEntry(entry as WorktreeEntry)])),
		};
	} catch {
		return emptyState();
	}
}

function writeState(statePath: string, state: CoordinatorState): void {
	mkdirSync(dirname(statePath), { recursive: true });
	const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tempPath, statePath);
}

async function withStateLock<T>(statePath: string, action: () => T | Promise<T>): Promise<T> {
	mkdirSync(dirname(statePath), { recursive: true });
	const lockPath = `${statePath}.lock`;
	const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS;

	while (true) {
		try {
			mkdirSync(lockPath, { recursive: false });
			break;
		} catch (error) {
			const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
			if (code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for worktree coordinator state lock: ${lockPath}`);
			await sleep(STATE_LOCK_RETRY_MS);
		}
	}

	try {
		return await action();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

async function updateState(statePath: string, update: (state: CoordinatorState) => void): Promise<CoordinatorState> {
	return await withStateLock(statePath, () => {
		const state = readState(statePath);
		update(state);
		writeState(statePath, state);
		return state;
	});
}

function parseStatusPaths(status: string): string[] {
	const paths = new Set<string>();
	for (const line of status.split("\n")) {
		if (!line.trim()) continue;
		const pathText = line.slice(3).trim();
		if (!pathText) continue;
		const renameTarget = pathText.includes(" -> ") ? pathText.split(" -> ").pop() : pathText;
		if (renameTarget) paths.add(renameTarget.replace(/^"|"$/g, ""));
	}
	return Array.from(paths).sort();
}

async function getDirtyFiles(pi: ExtensionAPI, git: GitContext): Promise<string[]> {
	const result = await runGit(pi, git.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (result.code !== 0) return [];
	return parseStatusPaths(result.stdout);
}

async function refreshCurrentEntry(pi: ExtensionAPI, git: GitContext, statePath = git.statePath): Promise<WorktreeEntry | undefined> {
	if (!currentEntry(readState(statePath), git)) return undefined;

	const dirtyFiles = await getDirtyFiles(pi, git);
	const timestamp = now();
	let updated: WorktreeEntry | undefined;

	await updateState(statePath, (state) => {
		const existing = state.worktrees[git.worktreePath];
		if (!existing || existing.status === "stopped") return;
		updated = {
			...existing,
			repoRoot: git.repoRoot,
			branch: git.branch,
			dirtyFiles,
			dirtyFileCount: dirtyFiles.length,
			updatedAt: timestamp,
			lastSeenAt: timestamp,
		};
		state.worktrees[git.worktreePath] = updated;
	});

	return updated;
}

function parseCommand(args: string): ParsedCommand {
	const trimmed = args.trim();
	if (!trimmed) return { action: "status", body: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return {
		action: (match?.[1] || "status").toLowerCase(),
		body: (match?.[2] || "").trim(),
	};
}

async function promptForText(ctx: ExtensionContext, title: string, placeholder: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const value = await ctx.ui.input(title, placeholder);
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function activeEntries(state: CoordinatorState): WorktreeEntry[] {
	return Object.values(state.worktrees)
		.filter((entry) => entry.status !== "stopped")
		.sort((a, b) => a.startedAt - b.startedAt);
}

function currentEntry(state: CoordinatorState, git: GitContext): WorktreeEntry | undefined {
	const entry = state.worktrees[git.worktreePath];
	return entry?.status === "stopped" ? undefined : entry;
}

function otherEntries(state: CoordinatorState, git: GitContext): WorktreeEntry[] {
	return activeEntries(state).filter((entry) => entry.worktreePath !== git.worktreePath);
}

function parseWorktreeList(output: string): WorktreeInfo[] {
	const worktrees: WorktreeInfo[] = [];
	let current: WorktreeInfo | undefined;

	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		if (line.startsWith("worktree ")) {
			if (current) worktrees.push(current);
			current = { path: line.slice("worktree ".length).trim() };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
		else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
		else if (line === "detached") current.detached = true;
		else if (line === "bare") current.bare = true;
	}

	if (current) worktrees.push(current);
	return worktrees;
}

async function getGitWorktrees(pi: ExtensionAPI, git: GitContext): Promise<WorktreeInfo[]> {
	const result = await runGit(pi, git.worktreePath, ["worktree", "list", "--porcelain"]);
	if (result.code !== 0) return [];
	return parseWorktreeList(result.stdout);
}

function worktreeLabel(entry: Pick<WorktreeEntry, "branch" | "worktreePath">, git: GitContext): string {
	return `${entry.branch || "unknown"} (${compactPath(entry.worktreePath, git.repoRoot)})`;
}

function formatDirtyFiles(entry: WorktreeEntry): string[] {
	if (entry.dirtyFileCount === 0) return ["- Dirty files: none"];
	const lines = [`- Dirty files: ${entry.dirtyFileCount}`];
	for (const file of entry.dirtyFiles.slice(0, MAX_STATUS_FILES)) {
		lines.push(`  - ${file}`);
	}
	if (entry.dirtyFiles.length > MAX_STATUS_FILES) {
		lines.push(`  - …and ${entry.dirtyFiles.length - MAX_STATUS_FILES} more`);
	}
	return lines;
}

function sharedDirtyFiles(entries: WorktreeEntry[]): string[] {
	const owners = new Map<string, Set<string>>();
	for (const entry of entries) {
		for (const file of entry.dirtyFiles) {
			const set = owners.get(file) ?? new Set<string>();
			set.add(entry.branch || entry.worktreePath);
			owners.set(file, set);
		}
	}
	return Array.from(owners.entries())
		.filter(([, branches]) => branches.size > 1)
		.map(([file, branches]) => `${file} (${Array.from(branches).join(", ")})`)
		.sort();
}

function renderRegisteredEntry(entry: WorktreeEntry, git: GitContext, current: boolean): string[] {
	return [
		`${current ? "## Current worktree" : `## ${worktreeLabel(entry, git)}`}`,
		...(current ? [`- Branch: ${entry.branch}`, `- Path: ${entry.worktreePath}`] : []),
		`- Status: ${entry.status}; last seen ${formatAge(entry.lastSeenAt)}`,
		`- Intent: ${entry.intent}`,
		...(entry.implementationArea ? [`- Broad implementation area: ${entry.implementationArea}`] : ["- Broad implementation area: not recorded yet; run `/wt update <area>` after code investigation."]),
		...formatDirtyFiles(entry),
	];
}

async function renderStatus(pi: ExtensionAPI, git: GitContext): Promise<string> {
	const refreshed = await refreshCurrentEntry(pi, git);
	const state = readState(git.statePath);
	const registered = activeEntries(state);
	const current = currentEntry(state, git) ?? refreshed;
	const others = otherEntries(state, git);
	const worktrees = await getGitWorktrees(pi, git);
	const registeredPaths = new Set(registered.map((entry) => entry.worktreePath));
	const unregistered = worktrees.filter((worktree) => !registeredPaths.has(worktree.path));
	const sharedFiles = sharedDirtyFiles(registered).slice(0, MAX_STATUS_FILES);

	const lines = [
		"# Worktree coordination",
		"",
		"This extension is advisory. It does not restrict edits or assign ownership. Overlap is allowed; prefer the correct design and call out integration risk when useful.",
		"",
	];

	if (current) {
		lines.push(...renderRegisteredEntry(current, git, true), "");
	} else {
		lines.push("## Current worktree", `- Branch: ${git.branch}`, `- Path: ${git.worktreePath}`, "- Not registered. Start coordination with `/wt start <intent>`.", "");
	}

	lines.push("## Other registered worktrees");
	if (others.length === 0) {
		lines.push("- None.");
	} else {
		for (const entry of others) {
			lines.push(`- ${worktreeLabel(entry, git)}`);
			lines.push(`  - Status: ${entry.status}; last seen ${formatAge(entry.lastSeenAt)}`);
			lines.push(`  - Intent: ${entry.intent}`);
			if (entry.implementationArea) lines.push(`  - Broad implementation area: ${entry.implementationArea}`);
			lines.push(`  - Dirty files: ${entry.dirtyFileCount}`);
		}
	}

	lines.push("", "## Possible exact dirty-file overlap");
	if (sharedFiles.length === 0) {
		lines.push("- None currently recorded.");
	} else {
		for (const file of sharedFiles) lines.push(`- ${file}`);
		if (sharedDirtyFiles(registered).length > sharedFiles.length) lines.push(`- …and ${sharedDirtyFiles(registered).length - sharedFiles.length} more`);
	}

	if (unregistered.length > 0) {
		lines.push("", "## Git worktrees not registered with /wt");
		for (const worktree of unregistered) {
			const label = worktree.branch ?? (worktree.detached && worktree.head ? `detached:${worktree.head.slice(0, 8)}` : "unknown");
			lines.push(`- ${label} (${compactPath(worktree.path, git.repoRoot)})`);
		}
	}

	return lines.join("\n");
}

function renderHelp(): string {
	return [
		"# /wt worktree coordinator",
		"",
		"Passive coordination for parallel git worktrees. It provides context, not restrictions.",
		"",
		"Commands:",
		"- `/wt start <intent>` — register this worktree/session with the user's implementation intent.",
		"- `/wt update <broad code area>` — record broad modules/packages/areas discovered after investigation.",
		"- `/wt status` — show registered worktrees, broad areas, and local dirty-file overlap.",
		"- `/wt stop` — mark this worktree as no longer participating in coordination.",
		"- `/wt help` — show this help.",
		"",
		"Design rule: overlap is allowed. The extension should help agents mention integration risk, not make them avoid correct refactors.",
	].join("\n");
}

async function startWorktree(pi: ExtensionAPI, ctx: ExtensionContext, git: GitContext, body: string): Promise<void> {
	const intent = body || (await promptForText(ctx, "Worktree intent", "What are you trying to implement in this worktree?"));
	if (!intent) {
		notify(ctx, "Usage: /wt start <intent>", "warning");
		return;
	}

	const dirtyFiles = await getDirtyFiles(pi, git);
	const timestamp = now();
	const sessionFile = ctx.sessionManager.getSessionFile();
	await updateState(git.statePath, (state) => {
		const existing = state.worktrees[git.worktreePath];
		state.worktrees[git.worktreePath] = {
			worktreePath: git.worktreePath,
			repoRoot: git.repoRoot,
			branch: git.branch,
			sessionFile,
			intent,
			implementationArea: undefined,
			status: "open",
			dirtyFiles,
			dirtyFileCount: dirtyFiles.length,
			startedAt: existing && existing.status !== "stopped" ? existing.startedAt : timestamp,
			updatedAt: timestamp,
			lastSeenAt: timestamp,
		};
	});

	updateStatus(pi, ctx, git);
	notify(ctx, `Registered worktree coordination for ${git.branch}.`, "info");
}

async function updateWorktree(pi: ExtensionAPI, ctx: ExtensionContext, git: GitContext, body: string): Promise<void> {
	const implementationArea =
		body ||
		(await promptForText(
			ctx,
			"Broad implementation area",
			"What broad modules/packages/code areas will this work likely touch?",
		));
	if (!implementationArea) {
		notify(ctx, "Usage: /wt update <broad code/module area>", "warning");
		return;
	}

	const dirtyFiles = await getDirtyFiles(pi, git);
	const timestamp = now();
	let updated = false;
	await updateState(git.statePath, (state) => {
		const existing = state.worktrees[git.worktreePath];
		if (!existing || existing.status === "stopped") return;
		state.worktrees[git.worktreePath] = {
			...existing,
			repoRoot: git.repoRoot,
			branch: git.branch,
			implementationArea,
			status: "open",
			dirtyFiles,
			dirtyFileCount: dirtyFiles.length,
			updatedAt: timestamp,
			lastSeenAt: timestamp,
		};
		updated = true;
	});

	if (!updated) {
		notify(ctx, "Run `/wt start <intent>` before `/wt update`.", "warning");
		return;
	}

	updateStatus(pi, ctx, git);
	notify(ctx, "Updated broad worktree implementation area.", "info");
}

async function stopWorktree(pi: ExtensionAPI, ctx: ExtensionContext, git: GitContext): Promise<void> {
	let stopped = false;
	await updateState(git.statePath, (state) => {
		const existing = state.worktrees[git.worktreePath];
		if (!existing || existing.status === "stopped") return;
		state.worktrees[git.worktreePath] = {
			...existing,
			status: "stopped",
			updatedAt: now(),
			lastSeenAt: now(),
		};
		stopped = true;
	});

	updateStatus(pi, ctx, git);
	notify(ctx, stopped ? "Stopped worktree coordination for this worktree." : "This worktree was not registered.", stopped ? "info" : "warning");
}

function renderContext(state: CoordinatorState, git: GitContext): string | undefined {
	const current = currentEntry(state, git);
	if (!current) return undefined;
	const others = otherEntries(state, git).slice(0, MAX_CONTEXT_ITEMS);
	const lines = [
		"Parallel git worktree coordination context:",
		`- Current branch: ${current.branch}`,
		`- Current intent: ${truncateLine(current.intent)}`,
		...(current.implementationArea ? [`- Broad implementation area: ${truncateLine(current.implementationArea)}`] : []),
	];

	if (others.length > 0) {
		lines.push("- Other registered worktrees:");
		for (const entry of others) {
			const area = entry.implementationArea ? `; area: ${truncateLine(entry.implementationArea, 120)}` : "";
			lines.push(`  - ${entry.branch}: ${truncateLine(entry.intent, 120)}${area}`);
		}
		const remaining = otherEntries(state, git).length - others.length;
		if (remaining > 0) lines.push(`  - …and ${remaining} more`);
	}

	lines.push(
		"This context is advisory, not a restriction. Overlap is allowed. Prefer the correct design over avoiding shared code; if shared work may affect parallel branches, mention the integration risk clearly.",
	);

	return lines.join("\n");
}

function updateStatus(_pi: ExtensionAPI, ctx: ExtensionContext, git: GitContext): void {
	if (!ctx.hasUI) return;
	const state = readState(git.statePath);
	const current = currentEntry(state, git);
	if (!current) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const otherCount = otherEntries(state, git).length;
	const area = current.implementationArea ? "area set" : "intent only";
	ctx.ui.setStatus(STATUS_KEY, `wt ${current.branch} · ${area}${otherCount > 0 ? ` · +${otherCount}` : ""}`);
}

async function handleSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const git = await getGitContext(pi, ctx);
	if (!git) return;
	if (!currentEntry(readState(git.statePath), git)) {
		updateStatus(pi, ctx, git);
		return;
	}

	const dirtyFiles = await getDirtyFiles(pi, git);
	const timestamp = now();
	await updateState(git.statePath, (state) => {
		const existing = currentEntry(state, git);
		if (!existing) return;
		state.worktrees[git.worktreePath] = {
			...existing,
			repoRoot: git.repoRoot,
			branch: git.branch,
			sessionFile: ctx.sessionManager.getSessionFile(),
			status: "open",
			dirtyFiles,
			dirtyFileCount: dirtyFiles.length,
			updatedAt: timestamp,
			lastSeenAt: timestamp,
		};
	});
	updateStatus(pi, ctx, git);
}

async function handleSessionShutdown(ctx: ExtensionContext): Promise<void> {
	const git = await getGitContextForShutdown(ctx);
	if (!git) return;
	await updateState(git.statePath, (state) => {
		const existing = currentEntry(state, git);
		if (!existing) return;
		state.worktrees[git.worktreePath] = {
			...existing,
			status: "idle",
			updatedAt: now(),
			lastSeenAt: now(),
		};
	});
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

async function getGitContextForShutdown(ctx: ExtensionContext): Promise<GitContext | undefined> {
	const cwd = ctx.cwd;
	const repoRoot = processGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
	const rawCommonDir = processGit(["-C", cwd, "rev-parse", "--git-common-dir"]);
	if (!repoRoot || !rawCommonDir) return undefined;
	const branch = processGit(["-C", cwd, "branch", "--show-current"]) || "unknown";
	const commonDir = isAbsolute(rawCommonDir) ? rawCommonDir : resolve(cwd, rawCommonDir);
	return {
		cwd,
		repoRoot,
		commonDir,
		statePath: join(commonDir, STATE_RELATIVE_PATH),
		worktreePath: repoRoot,
		branch,
	};
}

function processGit(args: string[]): string | undefined {
	try {
		const result = spawnSync("git", args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS });
		if (result.status !== 0) return undefined;
		return result.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

export default function worktreeCoordinator(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(MESSAGE_TYPE, (message) => {
		const details = message.details as { body?: string } | undefined;
		const fallback = typeof message.content === "string" ? message.content : "";
		return new Text(details?.body ?? fallback, 0, 0);
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Coordinate parallel git worktree intent and broad implementation areas without restricting edits",
		getArgumentCompletions(prefix) {
			const options = ["start ", "update ", "status", "stop", "help"];
			const filtered = options.filter((value) => value.startsWith(prefix));
			return filtered.length ? filtered.map((value) => ({ value, label: value.trim() })) : null;
		},
		handler: async (rawArgs, ctx) => {
			const parsed = parseCommand(rawArgs);
			if (parsed.action === "help" || parsed.action === "--help" || parsed.action === "-h") {
				sendOutput(pi, "worktree coordinator help", renderHelp());
				return;
			}

			const git = await getGitContext(pi, ctx);
			if (!git) {
				notify(ctx, "/wt requires a git repository.", "warning");
				return;
			}

			if (parsed.action === "start") {
				await startWorktree(pi, ctx, git, parsed.body);
				return;
			}

			if (parsed.action === "update") {
				await updateWorktree(pi, ctx, git, parsed.body);
				return;
			}

			if (parsed.action === "status") {
				sendOutput(pi, "worktree coordination status", await renderStatus(pi, git));
				updateStatus(pi, ctx, git);
				return;
			}

			if (parsed.action === "stop") {
				await stopWorktree(pi, ctx, git);
				return;
			}

			notify(ctx, `Unknown /wt action: ${parsed.action}`, "warning");
			sendOutput(pi, "worktree coordinator help", renderHelp());
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await handleSessionStart(pi, ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const git = await getGitContext(pi, ctx);
		if (!git) return;
		const context = renderContext(readState(git.statePath), git);
		if (!context) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		const git = await getGitContext(pi, ctx);
		if (!git) return;
		await refreshCurrentEntry(pi, git);
		updateStatus(pi, ctx, git);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await handleSessionShutdown(ctx);
	});
}
