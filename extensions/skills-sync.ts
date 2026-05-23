import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";

const COMMAND_SYNC = "skills-sync";
const COMMAND_CHECK = "skills-check";
const COMMAND_UPDATE_ALIAS = "skills-update";
const MESSAGE_TYPE = "skills-sync-output";
const STATUS_KEY = "skills";
const BUNX_BIN = "bunx";
const SKILLS_BIN = "skills";
const GLOBAL_LOCK_FILE = ".skill-lock.json";
const PROJECT_LOCK_FILE = "skills-lock.json";
const CHECK_TIMEOUT_MS = 120_000;
const UPDATE_TIMEOUT_MS = 180_000;
const MAX_RENDERED_OUTPUT = 30_000;
const STARTUP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const STATE_FILE = join(homedir(), ".pi", "agent", "state", "skills-sync.json");

const PRIORITY_SKILL_PATH_PREFIXES = ["skills", "skills/.curated", "skills/.experimental", "skills/.system", ".agents/skills", ".claude/skills"];

type Scope = "global" | "project";

type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

type LockedSkill = {
	name: string;
	scope: Scope;
	source?: string;
	sourceType?: string;
	sourceUrl?: string;
	ref?: string;
	skillPath?: string;
	skillFolderHash?: string;
	computedHash?: string;
};

type GitHubSource = {
	ownerRepo: string;
	ref?: string;
	subpath?: string;
};

type GitHubTreeEntry = {
	path: string;
	type: "tree" | "blob" | string;
	sha: string;
};

type GitHubTree = {
	sha: string;
	ref: string;
	entries: GitHubTreeEntry[];
};

type SkillUpdate = {
	name: string;
	scope: Scope;
	source: string;
	reason: string;
};

type SkippedSkill = {
	name: string;
	scope: Scope;
	reason: string;
};

type CheckResult = {
	updates: SkillUpdate[];
	skipped: SkippedSkill[];
	checked: number;
	output: string;
};

type TreeCache = Map<string, Promise<GitHubTree | undefined>>;

type ExtensionState = {
	lastStartupCheckAt?: number;
};

function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, kind);
}

function truncateOutput(output: string): string {
	if (output.length <= MAX_RENDERED_OUTPUT) return output;
	return `${output.slice(0, MAX_RENDERED_OUTPUT)}\n\n[truncated ${output.length - MAX_RENDERED_OUTPUT} characters]`;
}

function sendOutput(pi: ExtensionAPI, title: string, body: string): void {
	pi.sendMessage({
		customType: MESSAGE_TYPE,
		content: title,
		display: true,
		details: { body: truncateOutput(body) },
	});
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))].join(" ");
}

function commandOutput(title: string, command: string, args: string[], result: ExecResult): string {
	const sections = [`# ${title}`, "", `Command: \`${formatCommand(command, args)}\``, `Exit code: ${result.code}`];
	if (result.stdout.trim()) sections.push("", "## stdout", "```", result.stdout.trim(), "```");
	if (result.stderr.trim()) sections.push("", "## stderr", "```", result.stderr.trim(), "```");
	if (!result.stdout.trim() && !result.stderr.trim()) sections.push("", "No output.");
	return sections.join("\n");
}

async function runSkills(pi: ExtensionAPI, args: string[], timeout = CHECK_TIMEOUT_MS): Promise<ExecResult> {
	return await pi.exec(BUNX_BIN, [SKILLS_BIN, ...args], { timeout });
}

function globalLockPath(): string {
	const xdgStateHome = process.env.XDG_STATE_HOME;
	return xdgStateHome ? join(xdgStateHome, "skills", GLOBAL_LOCK_FILE) : join(homedir(), ".agents", GLOBAL_LOCK_FILE);
}

function projectLockPath(cwd: string): string {
	return join(cwd, PROJECT_LOCK_FILE);
}

async function readState(): Promise<ExtensionState> {
	const state = await readJsonFile(STATE_FILE);
	if (!state || typeof state !== "object") return {};
	const lastStartupCheckAt = (state as { lastStartupCheckAt?: unknown }).lastStartupCheckAt;
	return typeof lastStartupCheckAt === "number" && Number.isFinite(lastStartupCheckAt) ? { lastStartupCheckAt } : {};
}

async function writeState(state: ExtensionState): Promise<void> {
	await mkdir(dirname(STATE_FILE), { recursive: true });
	await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function shouldRunStartupCheck(): Promise<boolean> {
	const { lastStartupCheckAt } = await readState();
	return !lastStartupCheckAt || Date.now() - lastStartupCheckAt >= STARTUP_CHECK_INTERVAL_MS;
}

async function recordStartupCheck(): Promise<void> {
	await writeState({ lastStartupCheckAt: Date.now() });
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

function lockSkills(lock: unknown): Record<string, unknown> {
	if (!lock || typeof lock !== "object") return {};
	const skills = (lock as { skills?: unknown }).skills;
	return skills && typeof skills === "object" && !Array.isArray(skills) ? (skills as Record<string, unknown>) : {};
}

async function readLockedSkills(scope: Scope, cwd: string): Promise<LockedSkill[]> {
	const path = scope === "global" ? globalLockPath() : projectLockPath(cwd);
	const lock = await readJsonFile(path);
	return Object.entries(lockSkills(lock)).map(([name, rawEntry]) => {
		const entry = rawEntry && typeof rawEntry === "object" ? (rawEntry as Record<string, unknown>) : {};
		return {
			name,
			scope,
			source: stringValue(entry.source),
			sourceType: stringValue(entry.sourceType),
			sourceUrl: stringValue(entry.sourceUrl),
			ref: stringValue(entry.ref),
			skillPath: stringValue(entry.skillPath),
			skillFolderHash: stringValue(entry.skillFolderHash),
			computedHash: stringValue(entry.computedHash),
		};
	});
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function parseGitHubSource(skill: LockedSkill): GitHubSource | undefined {
	const source = skill.source ?? skill.sourceUrl;
	if (!source) return undefined;

	const shorthand = source.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/tree\/([^/]+)\/(.+))?$/);
	if (shorthand) return { ownerRepo: stripGitSuffix(shorthand[1]), ref: shorthand[2] ?? skill.ref, subpath: cleanPath(shorthand[3]) };

	const url = source.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+))?\/?$/);
	if (url) return { ownerRepo: stripGitSuffix(url[1]), ref: url[2] ?? skill.ref, subpath: cleanPath(url[3]) };

	const gitUrl = (skill.sourceUrl ?? "").match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
	if (gitUrl) return { ownerRepo: stripGitSuffix(gitUrl[1]), ref: skill.ref };

	return undefined;
}

function stripGitSuffix(value: string): string {
	return value.replace(/\.git$/, "");
}

function cleanPath(value: string | undefined): string | undefined {
	return value?.replace(/^\/+|\/+$/g, "") || undefined;
}

async function getGitHubToken(pi: ExtensionAPI): Promise<string | undefined> {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

	const result = await pi.exec("gh", ["auth", "token"], { timeout: 5_000 });
	const token = result.code === 0 ? result.stdout.trim() : "";
	return token || undefined;
}

function fetchRepoTree(pi: ExtensionAPI, source: GitHubSource, cache: TreeCache): Promise<GitHubTree | undefined> {
	const cacheKey = `${source.ownerRepo}#${source.ref ?? ""}`;
	const cached = cache.get(cacheKey);
	if (cached) return cached;

	const promise = fetchRepoTreeUncached(pi, source);
	cache.set(cacheKey, promise);
	return promise;
}

async function fetchRepoTreeUncached(pi: ExtensionAPI, source: GitHubSource): Promise<GitHubTree | undefined> {
	const refs = source.ref ? [source.ref] : ["HEAD", "main", "master"];
	let token: string | undefined;
	let needsToken = false;

	for (const ref of refs) {
		const result = await fetchRepoTreeRef(source.ownerRepo, ref, undefined);
		if (result.tree) return result.tree;
		if (result.rateLimited) {
			needsToken = true;
			break;
		}
	}

	if (!needsToken) return undefined;
	token = await getGitHubToken(pi);
	if (!token) return undefined;

	for (const ref of refs) {
		const result = await fetchRepoTreeRef(source.ownerRepo, ref, token);
		if (result.tree) return result.tree;
	}
	return undefined;
}

async function fetchRepoTreeRef(ownerRepo: string, ref: string, token: string | undefined): Promise<{ tree?: GitHubTree; rateLimited: boolean }> {
	try {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "pi-skills-sync",
		};
		if (token) headers.Authorization = `Bearer ${token}`;

		const response = await fetch(`https://api.github.com/repos/${ownerRepo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
			headers,
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			return { rateLimited: response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0" };
		}

		const data = (await response.json()) as { sha?: string; tree?: GitHubTreeEntry[] };
		if (!data.sha || !Array.isArray(data.tree)) return { rateLimited: false };
		return { tree: { sha: data.sha, ref, entries: data.tree }, rateLimited: false };
	} catch {
		return { rateLimited: false };
	}
}

function skillFolderFromSkillPath(skillPath: string): string {
	let folder = skillPath.replace(/\\/g, "/");
	if (folder.toLowerCase().endsWith("/skill.md")) folder = folder.slice(0, -9);
	else if (folder.toLowerCase().endsWith("skill.md")) folder = folder.slice(0, -8);
	return folder.replace(/\/$/, "");
}

function treeHashForSkillPath(tree: GitHubTree, skillPath: string): string | undefined {
	const folderPath = skillFolderFromSkillPath(skillPath);
	if (!folderPath) return tree.sha;
	return tree.entries.find((entry) => entry.type === "tree" && entry.path === folderPath)?.sha;
}

function candidateSkillPaths(skill: LockedSkill, source: GitHubSource): string[] {
	const explicit = skill.skillPath ? [skill.skillPath] : [];
	const subpath = source.subpath;
	const inferred = [
		...(subpath ? [posix.join(subpath, "SKILL.md"), posix.join(subpath, skill.name, "SKILL.md")] : []),
		...PRIORITY_SKILL_PATH_PREFIXES.map((prefix) => posix.join(prefix, skill.name, "SKILL.md")),
		posix.join(skill.name, "SKILL.md"),
	];
	return Array.from(new Set([...explicit, ...inferred].map((path) => path.replace(/\\/g, "/"))));
}

function findExistingSkillPath(tree: GitHubTree, paths: string[]): string | undefined {
	const pathSet = new Set(tree.entries.filter((entry) => entry.type === "blob" && entry.path.toLowerCase().endsWith("skill.md")).map((entry) => entry.path));
	return paths.find((path) => pathSet.has(path));
}

async function computeRemoteFolderHash(ownerRepo: string, tree: GitHubTree, folder: string): Promise<string | undefined> {
	const prefix = folder ? `${folder}/` : "";
	const files = tree.entries.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
	if (files.length === 0) return undefined;

	const hash = createHash("sha256");
	for (const file of files) {
		const relativePath = file.path.slice(prefix.length);
		const parts = relativePath.split("/");
		if (!relativePath || parts.includes(".git") || parts.includes("node_modules")) continue;
		const content = await fetchRawFile(ownerRepo, tree.ref, file.path);
		if (!content) return undefined;
		hash.update(relativePath);
		hash.update(Buffer.from(await content.arrayBuffer()));
	}
	return hash.digest("hex");
}

async function fetchRawFile(ownerRepo: string, ref: string, path: string): Promise<Response | undefined> {
	try {
		const encodedPath = path.split("/").map(encodeURIComponent).join("/");
		const response = await fetch(`https://raw.githubusercontent.com/${ownerRepo}/${encodeURIComponent(ref)}/${encodedPath}`, {
			signal: AbortSignal.timeout(20_000),
		});
		return response.ok ? response : undefined;
	} catch {
		return undefined;
	}
}

async function checkSkill(pi: ExtensionAPI, skill: LockedSkill, treeCache: TreeCache): Promise<{ update?: SkillUpdate; skipped?: SkippedSkill; checked?: boolean }> {
	if (skill.sourceType === "local" || skill.sourceType === "node_modules") {
		return { skipped: { name: skill.name, scope: skill.scope, reason: `${skill.sourceType} skills are not remotely updateable` } };
	}

	const source = parseGitHubSource(skill);
	if (!source || skill.sourceType === "git" || skill.sourceType === "well-known") {
		return { skipped: { name: skill.name, scope: skill.scope, reason: `unsupported source: ${skill.sourceType ?? "unknown"}` } };
	}

	const tree = await fetchRepoTree(pi, source, treeCache);
	if (!tree) {
		return { skipped: { name: skill.name, scope: skill.scope, reason: "could not fetch GitHub tree" } };
	}

	if (skill.skillPath && skill.skillFolderHash) {
		const latestHash = treeHashForSkillPath(tree, skill.skillPath);
		if (!latestHash) return { skipped: { name: skill.name, scope: skill.scope, reason: "remote skill folder was not found" } };
		return latestHash !== skill.skillFolderHash
			? { checked: true, update: { name: skill.name, scope: skill.scope, source: source.ownerRepo, reason: "remote folder hash changed" } }
			: { checked: true };
	}

	if (skill.computedHash) {
		const skillPath = findExistingSkillPath(tree, candidateSkillPaths(skill, source));
		if (!skillPath) return { skipped: { name: skill.name, scope: skill.scope, reason: "remote skill path could not be inferred" } };
		const latestHash = await computeRemoteFolderHash(source.ownerRepo, tree, skillFolderFromSkillPath(skillPath));
		if (!latestHash) return { skipped: { name: skill.name, scope: skill.scope, reason: "could not compute remote skill hash" } };
		return latestHash !== skill.computedHash
			? { checked: true, update: { name: skill.name, scope: skill.scope, source: source.ownerRepo, reason: "remote file hash changed" } }
			: { checked: true };
	}

	return { skipped: { name: skill.name, scope: skill.scope, reason: "lock file has no comparable hash" } };
}

async function checkInstalledSkills(pi: ExtensionAPI, ctx: ExtensionContext): Promise<CheckResult> {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "checking skills");
	const [globalSkills, projectSkills] = await Promise.all([readLockedSkills("global", ctx.cwd), readLockedSkills("project", ctx.cwd)]);
	const skills = [...globalSkills, ...projectSkills];
	const updates: SkillUpdate[] = [];
	const skipped: SkippedSkill[] = [];
	const treeCache: TreeCache = new Map();
	let checked = 0;

	for (const skill of skills) {
		const result = await checkSkill(pi, skill, treeCache);
		if (result.checked) checked++;
		if (result.update) updates.push(result.update);
		if (result.skipped) skipped.push(result.skipped);
	}

	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, updates.length > 0 ? `${updates.length} skill update${updates.length === 1 ? "" : "s"}` : undefined);
	return { updates, skipped, checked, output: formatCheckResult(globalSkills.length, projectSkills.length, checked, updates, skipped) };
}

function formatCheckResult(globalCount: number, projectCount: number, checked: number, updates: SkillUpdate[], skipped: SkippedSkill[]): string {
	const sections = [
		"# Skills sync check",
		"",
		`- Locked global skills: ${globalCount}`,
		`- Locked project skills: ${projectCount}`,
		`- Remotely checked: ${checked}`,
		`- Updates found: ${updates.length}`,
	];

	if (updates.length > 0) {
		sections.push("", "## Updates", ...updates.map((update) => `- ${update.name} (${update.scope}; ${update.reason}; ${update.source})`));
	} else {
		sections.push("", "All checkable skills are up to date.");
	}

	if (skipped.length > 0) {
		sections.push("", "## Not checked", ...skipped.map((skill) => `- ${skill.name} (${skill.scope}): ${skill.reason}`));
	}

	return sections.join("\n");
}

function groupedUpdateNames(updates: SkillUpdate[], scope: Scope): string[] {
	return Array.from(new Set(updates.filter((update) => update.scope === scope).map((update) => update.name))).sort();
}

function updateSummary(updates: SkillUpdate[]): string {
	const global = groupedUpdateNames(updates, "global");
	const project = groupedUpdateNames(updates, "project");
	const lines = [];
	if (global.length > 0) lines.push(`Global: ${global.join(", ")}`);
	if (project.length > 0) lines.push(`Project: ${project.join(", ")}`);
	return lines.join("\n");
}

async function applyUpdates(pi: ExtensionAPI, ctx: ExtensionContext, updates: SkillUpdate[]): Promise<boolean> {
	const steps: string[] = ["# Skills update", ""];
	let failed = false;

	for (const scope of ["global", "project"] as const) {
		const names = groupedUpdateNames(updates, scope);
		if (names.length === 0) continue;

		const args = ["update", scope === "global" ? "-g" : "-p", "-y", ...names];
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `updating ${scope} skills`);
		const result = await runSkills(pi, args, UPDATE_TIMEOUT_MS);
		steps.push(commandOutput(`${scope} skills update`, BUNX_BIN, [SKILLS_BIN, ...args], result), "");
		if (result.code !== 0) failed = true;
	}

	sendOutput(pi, "skills update", steps.join("\n"));
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	if (failed) {
		notify(ctx, "Some skill updates failed. See skills update output.", "error");
		return false;
	}

	notify(ctx, "Skill updates complete.", "info");
	if (ctx.hasUI && (await ctx.ui.confirm("Reload pi resources?", "Run /reload so pi picks up changed skills?"))) {
		await ctx.reload();
	}
	return true;
}

async function promptForUpdates(pi: ExtensionAPI, ctx: ExtensionContext, result: CheckResult, showCleanOutput = false): Promise<void> {
	if (result.updates.length === 0) {
		if (showCleanOutput) sendOutput(pi, "skills sync check", result.output);
		notify(ctx, "All checkable skills are up to date.", "info");
		return;
	}

	sendOutput(pi, "skills sync check", result.output);
	if (!ctx.hasUI) return;

	const ok = await ctx.ui.confirm(
		"Update installed skills?",
		`${countLabel(result.updates.length, "skill")} can be updated.\n\n${updateSummary(result.updates)}\n\nUpdate with \`bunx skills update\` now?`,
	);
	if (!ok) {
		notify(ctx, "Skill updates skipped.", "warning");
		return;
	}

	await applyUpdates(pi, ctx, result.updates);
}

async function runCheckCommand(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const result = await checkInstalledSkills(pi, ctx);
		sendOutput(pi, "skills sync check", result.output);
		notify(ctx, result.updates.length > 0 ? `${countLabel(result.updates.length, "skill")} can be updated. Run /skills-sync to update after confirmation.` : "All checkable skills are up to date.", "info");
	} catch (error) {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		notify(ctx, `Skills sync check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function runSyncCommand(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const result = await checkInstalledSkills(pi, ctx);
		await promptForUpdates(pi, ctx, result, true);
	} catch (error) {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		notify(ctx, `Skills sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export default function skillsSync(pi: ExtensionAPI): void {
	let startupCheckDone = false;

	pi.registerMessageRenderer(MESSAGE_TYPE, (message) => {
		const details = message.details as { body?: string } | undefined;
		const fallback = typeof message.content === "string" ? message.content : "";
		return new Text(details?.body ?? fallback, 0, 0);
	});

	pi.registerCommand(COMMAND_SYNC, {
		description: "Check global and project skills, then update stale skills after confirmation",
		handler: async (_args, ctx) => {
			await runSyncCommand(pi, ctx);
		},
	});

	pi.registerCommand(COMMAND_CHECK, {
		description: "Check global and project skills for updates without changing them",
		handler: async (_args, ctx) => {
			await runCheckCommand(pi, ctx);
		},
	});

	pi.registerCommand(COMMAND_UPDATE_ALIAS, {
		description: "Alias for /skills-sync",
		handler: async (_args, ctx) => {
			await runSyncCommand(pi, ctx);
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload" || startupCheckDone) return;
		startupCheckDone = true;
		if (!existsSync(globalLockPath()) && !existsSync(projectLockPath(ctx.cwd))) return;
		if (!(await shouldRunStartupCheck())) return;

		try {
			const result = await checkInstalledSkills(pi, ctx);
			await recordStartupCheck();
			if (result.updates.length > 0) await promptForUpdates(pi, ctx, result);
		} catch (error) {
			notify(ctx, `Skills sync check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
