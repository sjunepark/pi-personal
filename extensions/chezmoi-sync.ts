import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMAND_NAME = "chezmoi-sync";
const MESSAGE_TYPE = "chezmoi-sync-output";
const STATUS_KEY = "chezmoi-sync";
const CHEZMOI_BIN = "chezmoi";
const PI_BIN = "pi";
const DEFAULT_TIMEOUT_MS = 30_000;
const MUTATING_TIMEOUT_MS = 120_000;
const MAX_RENDERED_OUTPUT = 30_000;
const AGENTS_TARGET = join(homedir(), ".pi", "agent", "AGENTS.md");

type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

type CommandStep = {
	title: string;
	command: string;
	args: string[];
	result: ExecResult;
};

type PublishOutcome = {
	status: "succeeded" | "failed" | "cancelled" | "stale";
	steps: CommandStep[];
	message?: string;
};

type PublishSnapshot = {
	head: ExecResult;
	status: ExecResult;
	diff: ExecResult;
	untracked: string;
};

type PublishReview = {
	target: PublishTarget;
	snapshot: PublishSnapshot;
	body: string;
};

type ParsedCommand = {
	action: string;
	args: string[];
};

type RepoKey = "chezmoi" | "pi-personal";

type RepoState = {
	key: RepoKey;
	label: string;
	path: string;
	branch?: string;
	upstream?: string;
	status: string;
	dirty: boolean;
	ahead: number;
	behind: number;
	fetchError?: string;
};

type SyncState = {
	managedStatus: string;
	managedDrift: boolean;
	chezmoiRepo?: RepoState;
	piPersonalRepo?: RepoState;
};

type PublishTarget = {
	key: RepoKey;
	label: string;
	path: string;
	state: RepoState;
};

function parseCommand(input: string): ParsedCommand | { error: string } {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	let tokenStarted = false;

	for (const char of input.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			tokenStarted = true;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaping = true;
			tokenStarted = true;
			continue;
		}

		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			tokenStarted = true;
			continue;
		}

		if (/\s/.test(char) && !quote) {
			if (tokenStarted) {
				tokens.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}

		current += char;
		tokenStarted = true;
	}

	if (escaping) current += "\\";
	if (quote) return { error: `Unterminated ${quote === '"' ? "double" : "single"} quote.` };
	if (tokenStarted) tokens.push(current);

	return {
		action: (tokens[0] || "review").toLowerCase(),
		args: tokens.slice(1),
	};
}

function normalizeTarget(target: string): string {
	if (target === "agents" || target === "AGENTS.md") return AGENTS_TARGET;
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return join(homedir(), target.slice(2));
	return target;
}

function normalizeTargets(args: string[]): string[] {
	return args.map(normalizeTarget);
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))].join(" ");
}

function commandLine(args: string[]): string {
	return formatCommand(CHEZMOI_BIN, args);
}

function truncateOutput(output: string): string {
	if (output.length <= MAX_RENDERED_OUTPUT) return output;
	const omitted = output.length - MAX_RENDERED_OUTPUT;
	return `${output.slice(0, MAX_RENDERED_OUTPUT)}\n\n[truncated ${omitted} characters]`;
}

function formatCommandResult(title: string, command: string, args: string[], result: ExecResult): string {
	const sections = [`# ${title}`, "", `Command: \`${formatCommand(command, args)}\``, `Exit code: ${result.code}`];
	const stdout = result.stdout.trim();
	const stderr = result.stderr.trim();

	if (stdout) sections.push("", "## stdout", "```", stdout, "```");
	if (stderr) sections.push("", "## stderr", "```", stderr, "```");
	if (!stdout && !stderr) sections.push("", "No output.");

	return truncateOutput(sections.join("\n"));
}

function formatChezmoiResult(title: string, args: string[], result: ExecResult): string {
	return formatCommandResult(title, CHEZMOI_BIN, args, result);
}

function formatStepResults(title: string, steps: CommandStep[]): string {
	const sections = [`# ${title}`, ""];

	for (const [index, step] of steps.entries()) {
		if (index > 0) sections.push("");
		sections.push(`## ${step.title}`, "", `Command: \`${formatCommand(step.command, step.args)}\``, `Exit code: ${step.result.code}`);

		const stdout = step.result.stdout.trim();
		const stderr = step.result.stderr.trim();
		if (stdout) sections.push("", "### stdout", "```", stdout, "```");
		if (stderr) sections.push("", "### stderr", "```", stderr, "```");
		if (!stdout && !stderr) sections.push("", "No output.");
	}

	return truncateOutput(sections.join("\n"));
}

function sendOutput(pi: ExtensionAPI, title: string, body: string): void {
	pi.sendMessage({
		customType: MESSAGE_TYPE,
		content: title,
		display: true,
		details: { body },
	});
}

function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, kind);
}

async function hasChezmoi(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("which", [CHEZMOI_BIN], { timeout: 5_000 });
	return result.code === 0 && result.stdout.trim().length > 0;
}

async function runChezmoi(pi: ExtensionAPI, args: string[], timeout = DEFAULT_TIMEOUT_MS): Promise<ExecResult> {
	return await pi.exec(CHEZMOI_BIN, args, { timeout });
}

async function runPi(pi: ExtensionAPI, args: string[], timeout = MUTATING_TIMEOUT_MS): Promise<ExecResult> {
	return await pi.exec(PI_BIN, args, { timeout });
}

async function runGit(pi: ExtensionAPI, cwd: string, args: string[], timeout = DEFAULT_TIMEOUT_MS): Promise<ExecResult> {
	return await pi.exec("git", ["-C", cwd, ...args], { timeout });
}

async function confirm(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return await ctx.ui.confirm(title, message);
}

async function input(ctx: ExtensionContext, title: string, placeholder: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const value = await ctx.ui.input(title, placeholder);
	const trimmed = value?.trim();
	return trimmed || undefined;
}

async function select(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	return await ctx.ui.select(title, options);
}

async function getChezmoiSourceDir(pi: ExtensionAPI): Promise<string | undefined> {
	const result = await runChezmoi(pi, ["source-path"], 10_000);
	const sourceDir = result.stdout.trim();
	return result.code === 0 && sourceDir ? sourceDir : undefined;
}

async function getGitRoot(pi: ExtensionAPI, path: string): Promise<string | undefined> {
	const result = await runGit(pi, path, ["rev-parse", "--show-toplevel"], 10_000);
	const root = result.stdout.trim();
	return result.code === 0 && root ? root : undefined;
}

async function getPiPersonalRepoDir(pi: ExtensionAPI): Promise<string | undefined> {
	const extensionFile = fileURLToPath(import.meta.url);
	const extensionDir = dirname(extensionFile);
	return await getGitRoot(pi, extensionDir);
}

function parseCount(value: string | undefined): number {
	const parsed = Number.parseInt(value || "0", 10);
	return Number.isFinite(parsed) ? parsed : 0;
}

async function inspectRepo(pi: ExtensionAPI, key: RepoKey, label: string, path: string): Promise<RepoState | undefined> {
	if (!existsSync(path)) return undefined;

	const root = (await getGitRoot(pi, path)) || path;
	const fetch = await runGit(pi, root, ["fetch", "--quiet"], 20_000);
	const branch = await runGit(pi, root, ["branch", "--show-current"], 10_000);
	const upstream = await runGit(pi, root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], 10_000);
	const status = await runGit(pi, root, ["status", "--porcelain"], 10_000);

	let ahead = 0;
	let behind = 0;
	if (upstream.code === 0) {
		const counts = await runGit(pi, root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], 10_000);
		if (counts.code === 0) {
			const [aheadText, behindText] = counts.stdout.trim().split(/\s+/);
			ahead = parseCount(aheadText);
			behind = parseCount(behindText);
		}
	}

	return {
		key,
		label,
		path: root,
		branch: branch.stdout.trim() || undefined,
		upstream: upstream.code === 0 ? upstream.stdout.trim() || undefined : undefined,
		status: status.stdout.trim(),
		dirty: status.code === 0 && status.stdout.trim().length > 0,
		ahead,
		behind,
		fetchError: fetch.code === 0 ? undefined : (fetch.stderr || fetch.stdout).trim() || "git fetch failed",
	};
}

function hasInbound(state: SyncState): boolean {
	return Boolean(state.chezmoiRepo?.behind || state.piPersonalRepo?.behind);
}

function hasOutbound(state: SyncState): boolean {
	return Boolean(
		state.chezmoiRepo?.dirty ||
			state.chezmoiRepo?.ahead ||
			state.piPersonalRepo?.dirty ||
			state.piPersonalRepo?.ahead ||
			state.managedDrift,
	);
}

function hasPendingWork(state: SyncState): boolean {
	return state.managedDrift || hasInbound(state) || hasOutbound(state);
}

async function inspectSyncState(pi: ExtensionAPI): Promise<SyncState> {
	const status = await runChezmoi(pi, ["status"], 10_000);
	const managedStatus = status.code === 0 ? status.stdout.trim() : "";
	const chezmoiSource = await getChezmoiSourceDir(pi);
	const piPersonalSource = await getPiPersonalRepoDir(pi);

	return {
		managedStatus,
		managedDrift: managedStatus.length > 0,
		chezmoiRepo: chezmoiSource ? await inspectRepo(pi, "chezmoi", "chezmoi source", chezmoiSource) : undefined,
		piPersonalRepo: piPersonalSource ? await inspectRepo(pi, "pi-personal", "pi-personal package", piPersonalSource) : undefined,
	};
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function repoWorkSummary(repo: RepoState | undefined): string {
	if (!repo) return "not found";

	const items: string[] = [];
	if (repo.behind > 0) items.push(`${countLabel(repo.behind, "remote commit")} to pull`);
	if (repo.dirty) items.push("uncommitted local changes");
	if (repo.ahead > 0) items.push(`${countLabel(repo.ahead, "local commit")} to push`);
	return items.length > 0 ? items.join("; ") : "clean";
}

function repoSummary(repo: RepoState | undefined): string[] {
	if (!repo) return ["- Not found."];

	const parts = [`- State: ${repoWorkSummary(repo)}`, `- Path: ${repo.path}`];
	if (repo.branch) parts.push(`- Branch: ${repo.branch}`);
	if (repo.upstream) parts.push(`- Remote tracking branch: ${repo.upstream}`);
	if (repo.fetchError) parts.push(`- Fetch warning: ${repo.fetchError}`);
	if (repo.status) parts.push("- Git status:", "```", repo.status, "```");
	return parts;
}

function renderSyncReview(state: SyncState): string {
	const hasRemoteChanges = hasInbound(state);
	const hasLocalRepoChanges = Boolean(state.chezmoiRepo?.dirty || state.chezmoiRepo?.ahead || state.piPersonalRepo?.dirty || state.piPersonalRepo?.ahead);
	const managedTargets = state.managedDrift ? parseManagedTargetPaths(state.managedStatus) : [];
	const managedTargetLines = managedTargets.slice(0, 8).map((target) => `  - ${target}`);
	if (managedTargets.length > managedTargetLines.length) {
		managedTargetLines.push(`  - …and ${countLabel(managedTargets.length - managedTargetLines.length, "more file")}`);
	}

	const nextSteps: string[] = [];
	if (!hasRemoteChanges && !hasLocalRepoChanges && !state.managedDrift) {
		nextSteps.push("- Nothing to do. Local files, local source repos, and remotes look current.");
	} else {
		if (state.managedDrift) {
			nextSteps.push("- First decide which copy is correct for the changed managed files.");
			nextSteps.push("  - Keep the local machine version: `/chezmoi-sync add <target>` or `/chezmoi-sync add-agents`.");
			nextSteps.push("  - Restore the chezmoi source version onto this machine: `/chezmoi-sync apply <target>`.");
			nextSteps.push("  - Inspect the exact difference first: `/chezmoi-sync diff`.");
		}
		if (hasRemoteChanges) nextSteps.push("- Pull remote updates into this machine: `/chezmoi-sync sync`.");
		if (hasLocalRepoChanges) nextSteps.push("- Publish reviewed local repo changes: `/chezmoi-sync publish`.");
	}

	return [
		"# Pi sync review",
		"",
		"Pi sync has three places to keep aligned:",
		"",
		"```text",
		"local machine files  ↔  local chezmoi source  ↔  remote chezmoi git",
		"```",
		"",
		"`pi-personal` is also checked as a local git repo with its own remote.",
		"",
		"## At a glance",
		`- Local machine ↔ local chezmoi source: ${state.managedDrift ? "needs a decision" : "clean"}`,
		`- Local chezmoi source ↔ remote: ${repoWorkSummary(state.chezmoiRepo)}`,
		`- pi-personal package ↔ remote: ${repoWorkSummary(state.piPersonalRepo)}`,
		"",
		"## What needs attention",
		...(state.managedDrift
			? [
					"- Managed files on this machine differ from the local chezmoi source.",
					...(managedTargetLines.length > 0 ? managedTargetLines : ["  - Run `/chezmoi-sync status` to see the changed targets."]),
				]
			: ["- No local machine/source drift detected."]),
		...(hasRemoteChanges
			? [
					...(state.chezmoiRepo?.behind ? [`- Remote chezmoi has ${countLabel(state.chezmoiRepo.behind, "commit")} not on this machine.`] : []),
					...(state.piPersonalRepo?.behind ? [`- Remote pi-personal has ${countLabel(state.piPersonalRepo.behind, "commit")} not on this machine.`] : []),
				]
			: ["- No remote commits are waiting to be pulled."]),
		...(hasLocalRepoChanges
			? [
					...(state.chezmoiRepo?.dirty ? ["- Local chezmoi source has uncommitted changes."] : []),
					...(state.chezmoiRepo?.ahead ? [`- Local chezmoi source has ${countLabel(state.chezmoiRepo.ahead, "commit")} not pushed.`] : []),
					...(state.piPersonalRepo?.dirty ? ["- Local pi-personal has uncommitted changes."] : []),
					...(state.piPersonalRepo?.ahead ? [`- Local pi-personal has ${countLabel(state.piPersonalRepo.ahead, "commit")} not pushed.`] : []),
				]
			: ["- No local repo changes are waiting to be published."]),
		"",
		"## Recommended next step",
		...nextSteps,
		...(state.managedStatus ? ["", "## Raw chezmoi status", "```", state.managedStatus, "```"] : []),
		"",
		"## Technical details",
		"",
		"### chezmoi source repo",
		...repoSummary(state.chezmoiRepo),
		"",
		"### pi-personal repo",
		...repoSummary(state.piPersonalRepo),
	].join("\n");
}

async function refreshStatus(pi: ExtensionAPI, ctx: ExtensionContext, state?: SyncState): Promise<void> {
	if (!ctx.hasUI) return;
	if (!(await hasChezmoi(pi))) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const syncState = state ?? (await inspectSyncState(pi));
	if (!hasPendingWork(syncState)) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const labels = [];
	if (hasInbound(syncState)) labels.push("in");
	if (hasOutbound(syncState)) labels.push("out");
	if (syncState.managedDrift) labels.push("drift");
	ctx.ui.setStatus(STATUS_KEY, `chezmoi sync ${labels.join("+")}`);
}

function usage(): string {
	return [
		"# chezmoi sync",
		"",
		"Main commands:",
		"- `/chezmoi-sync` or `/chezmoi-sync review` — inspect inbound/outbound sync state",
		"- `/chezmoi-sync sync` — run inbound sync: `chezmoi update`, `pi update --extensions`, then offer `/reload`",
		"- `/chezmoi-sync publish` — review, commit, rebase, and push local changes after confirmation",
		"- `/chezmoi-sync publish chezmoi|pi-personal|all` — publish selected source(s)",
		"",
		"Lower-level commands:",
		"- `/chezmoi-sync status` — show pending chezmoi target/source changes",
		"- `/chezmoi-sync diff [target...]` — show chezmoi diff",
		"- `/chezmoi-sync apply [target...]` — apply source state to target files after confirmation",
		"- `/chezmoi-sync update` — run `chezmoi update` after confirmation",
		"- `/chezmoi-sync add <target...>` — update chezmoi source from target files after confirmation",
		"- `/chezmoi-sync add-agents` — update chezmoi source from `~/.pi/agent/AGENTS.md`",
		"- `/chezmoi-sync source-path [target]` — show chezmoi source path",
		"",
		"Target aliases: `agents` and `AGENTS.md` both mean `~/.pi/agent/AGENTS.md`.",
	].join("\n");
}

function parseManagedTargetPaths(status: string): string[] {
	return status
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter(Boolean)
		.map((path) => (path.startsWith("/") ? path : join(homedir(), path)));
}

function selectablePublishTargets(state: SyncState): PublishTarget[] {
	const targets: PublishTarget[] = [];
	if (state.chezmoiRepo && (state.chezmoiRepo.dirty || state.chezmoiRepo.ahead)) {
		targets.push({ key: "chezmoi", label: "chezmoi source", path: state.chezmoiRepo.path, state: state.chezmoiRepo });
	}
	if (state.piPersonalRepo && (state.piPersonalRepo.dirty || state.piPersonalRepo.ahead)) {
		targets.push({ key: "pi-personal", label: "pi-personal package", path: state.piPersonalRepo.path, state: state.piPersonalRepo });
	}
	return targets;
}

function matchPublishTargets(scope: string | undefined, state: SyncState): PublishTarget[] {
	const available = selectablePublishTargets(state);
	if (!scope || scope === "all") return available;
	if (scope === "chezmoi") return available.filter((target) => target.key === "chezmoi");
	if (scope === "pi-personal" || scope === "personal" || scope === "package") return available.filter((target) => target.key === "pi-personal");
	return [];
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function readableStatus(status: string): string {
	return status.replaceAll("\0", "\n").trim() || "clean";
}

function snapshotError(snapshot: PublishSnapshot): string | undefined {
	if (snapshot.head.code !== 0) return "git rev-parse HEAD failed";
	if (snapshot.status.code !== 0) return "git status failed";
	if (snapshot.diff.code !== 0) return "git diff HEAD failed";
	if (snapshot.untracked.startsWith("git ls-files failed")) return "git ls-files failed";
	if (snapshot.untracked.split("\n").some((entry) => entry && !entry.startsWith("0\t"))) return "git hash-object failed";
	return undefined;
}

function snapshotKey(snapshot: PublishSnapshot): string {
	return JSON.stringify({ head: snapshot.head, status: snapshot.status, diff: snapshot.diff, untracked: snapshot.untracked });
}

function formatSnapshotSummary(snapshot: PublishSnapshot): string {
	return [
		`- HEAD: ${snapshot.head.stdout.trim() || "unknown"}`,
		`- status hash: ${hashText(snapshot.status.stdout)}`,
		`- diff hash: ${hashText(snapshot.diff.stdout)}`,
		`- untracked hash: ${hashText(snapshot.untracked)}`,
		"",
		"### status",
		"```",
		readableStatus(snapshot.status.stdout),
		"```",
	].join("\n");
}

function formatSnapshotMismatch(target: PublishTarget, reviewed: PublishSnapshot, current: PublishSnapshot): string {
	return truncateOutput(
		[
			`# Publish stopped: ${target.label} changed after review`,
			"",
			"The repository state no longer matches the reviewed publish snapshot. Run `/chezmoi-sync publish` again to review the latest changes before committing or pushing.",
			"",
			"## Reviewed snapshot",
			formatSnapshotSummary(reviewed),
			"",
			"## Current snapshot",
			formatSnapshotSummary(current),
		].join("\n"),
	);
}

async function captureUntrackedSnapshot(pi: ExtensionAPI, path: string): Promise<string> {
	const listed = await runGit(pi, path, ["ls-files", "--others", "--exclude-standard", "-z"], 10_000);
	if (listed.code !== 0) return `git ls-files failed\n${listed.stderr || listed.stdout}`;

	const paths = listed.stdout.split("\0").filter(Boolean).sort();
	const entries: string[] = [];
	for (const file of paths) {
		const hash = await runGit(pi, path, ["hash-object", "--", file], 10_000);
		entries.push(`${hash.code}\t${hash.stdout.trim()}\t${file}${hash.stderr.trim() ? `\t${hash.stderr.trim()}` : ""}`);
	}
	return entries.join("\n");
}

async function capturePublishSnapshot(pi: ExtensionAPI, target: PublishTarget): Promise<PublishSnapshot> {
	const head = await runGit(pi, target.path, ["rev-parse", "HEAD"], 10_000);
	const status = await runGit(pi, target.path, ["status", "--porcelain=v1", "-z"], 10_000);
	const diff = await runGit(pi, target.path, ["diff", "--binary", "HEAD", "--"], 20_000);
	const untracked = await captureUntrackedSnapshot(pi, target.path);
	return { head, status, diff, untracked };
}

async function renderPublishReview(pi: ExtensionAPI, target: PublishTarget): Promise<PublishReview> {
	const snapshot = await capturePublishSnapshot(pi, target);
	const status = await runGit(pi, target.path, ["status", "--short"], 10_000);
	const diffStat = await runGit(pi, target.path, ["diff", "--stat", "HEAD", "--"], 10_000);
	const log = target.state.ahead > 0 ? await runGit(pi, target.path, ["log", "--oneline", "@{upstream}..HEAD"], 10_000) : undefined;

	const body = [
		`## ${target.label}`,
		"",
		`Path: ${target.path}`,
		"",
		"### status",
		"```",
		status.stdout.trim() || "clean",
		"```",
		"",
		"### reviewed snapshot",
		`- HEAD: ${snapshot.head.stdout.trim() || "unknown"}`,
		`- diff hash: ${hashText(snapshot.diff.stdout)}`,
		`- untracked hash: ${hashText(snapshot.untracked)}`,
		...(diffStat.stdout.trim() ? ["", "### diff stat against HEAD", "```", diffStat.stdout.trim(), "```"] : []),
		...(snapshot.diff.stdout.trim() ? ["", "### diff against HEAD", "```diff", snapshot.diff.stdout.trim(), "```"] : []),
		...(snapshot.untracked.trim() ? ["", "### untracked file hashes", "```", snapshot.untracked, "```"] : []),
		...(log?.stdout.trim() ? ["", "### unpushed commits", "```", log.stdout.trim(), "```"] : []),
	].join("\n");

	return { target, snapshot, body };
}

async function maybeAddManagedChezmoiDrift(pi: ExtensionAPI, ctx: ExtensionContext, state: SyncState): Promise<ExecResult | undefined> {
	if (!state.managedDrift) return undefined;

	const targets = parseManagedTargetPaths(state.managedStatus);
	if (targets.length === 0) return undefined;

	const diff = await runChezmoi(pi, ["diff"], DEFAULT_TIMEOUT_MS);
	sendOutput(pi, "chezmoi managed-file drift", formatChezmoiResult("chezmoi diff", ["diff"], diff));

	const ok = await confirm(
		ctx,
		"Add current target files to chezmoi source?",
		`chezmoi-managed files differ from source. Run \`${commandLine(["add", ...targets])}\` before publishing chezmoi? Choose no if the source copy is actually the intended state.`,
	);
	if (!ok) return undefined;

	return await runChezmoi(pi, ["add", ...targets], MUTATING_TIMEOUT_MS);
}

async function publishRepo(pi: ExtensionAPI, ctx: ExtensionContext, review: PublishReview): Promise<PublishOutcome> {
	const { target } = review;
	const steps: CommandStep[] = [];
	const latestState = await inspectRepo(pi, target.key, target.label, target.path);
	if (!latestState) return { status: "failed", steps, message: `${target.label} could not be inspected.` };

	let committedDirtyChanges = false;
	if (latestState.dirty) {
		const message = await input(ctx, `${target.label} commit message`, `Update ${target.label}`);
		if (!message) {
			return { status: "cancelled", steps, message: `${target.label} publish cancelled: missing commit message.` };
		}

		const currentSnapshot = await capturePublishSnapshot(pi, target);
		if (snapshotKey(currentSnapshot) !== snapshotKey(review.snapshot)) {
			sendOutput(pi, "chezmoi sync publish stopped", formatSnapshotMismatch(target, review.snapshot, currentSnapshot));
			return { status: "stale", steps, message: `${target.label} changed after review; publish stopped.` };
		}

		const addArgs = ["add", "-A"];
		const add = await runGit(pi, target.path, addArgs, MUTATING_TIMEOUT_MS);
		steps.push({ title: `${target.label}: stage changes`, command: "git", args: ["-C", target.path, ...addArgs], result: add });
		if (add.code !== 0) return { status: "failed", steps };

		const commitArgs = ["commit", "-m", message];
		const commit = await runGit(pi, target.path, commitArgs, MUTATING_TIMEOUT_MS);
		steps.push({ title: `${target.label}: commit changes`, command: "git", args: ["-C", target.path, ...commitArgs], result: commit });
		if (commit.code !== 0) return { status: "failed", steps };
		committedDirtyChanges = true;
	}

	if (!committedDirtyChanges) {
		const currentSnapshot = await capturePublishSnapshot(pi, target);
		if (snapshotKey(currentSnapshot) !== snapshotKey(review.snapshot)) {
			sendOutput(pi, "chezmoi sync publish stopped", formatSnapshotMismatch(target, review.snapshot, currentSnapshot));
			return { status: "stale", steps, message: `${target.label} changed after review; publish stopped.` };
		}
	}

	const afterCommit = await inspectRepo(pi, target.key, target.label, target.path);
	if (!afterCommit) return { status: "failed", steps, message: `${target.label} could not be inspected after committing.` };

	if (afterCommit.upstream) {
		const pullArgs = ["pull", "--rebase"];
		const pull = await runGit(pi, target.path, pullArgs, MUTATING_TIMEOUT_MS);
		steps.push({ title: `${target.label}: rebase onto upstream`, command: "git", args: ["-C", target.path, ...pullArgs], result: pull });
		if (pull.code !== 0) return { status: "failed", steps };
	}

	const pushArgs = ["push"];
	const push = await runGit(pi, target.path, pushArgs, MUTATING_TIMEOUT_MS);
	steps.push({ title: `${target.label}: push`, command: "git", args: ["-C", target.path, ...pushArgs], result: push });
	return { status: push.code === 0 ? "succeeded" : "failed", steps };
}

async function runFullSync(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "syncing pi");
	notify(ctx, "Syncing pi config and packages...", "info");

	const steps: CommandStep[] = [];
	const chezmoiUpdateArgs = ["update"];
	const chezmoiUpdate = await runChezmoi(pi, chezmoiUpdateArgs, MUTATING_TIMEOUT_MS);
	steps.push({ title: "Update and apply chezmoi source", command: CHEZMOI_BIN, args: chezmoiUpdateArgs, result: chezmoiUpdate });

	if (chezmoiUpdate.code === 0) {
		const piUpdateArgs = ["update", "--extensions"];
		const piUpdate = await runPi(pi, piUpdateArgs, MUTATING_TIMEOUT_MS);
		steps.push({ title: "Update pi packages", command: PI_BIN, args: piUpdateArgs, result: piUpdate });
	}

	const failed = steps.find((step) => step.result.code !== 0);
	sendOutput(pi, "chezmoi sync", formatStepResults("chezmoi sync", steps));
	await refreshStatus(pi, ctx);

	if (failed) {
		notify(ctx, `${failed.title} failed. See sync output.`, "error");
		return;
	}

	notify(ctx, "chezmoi sync complete.", "info");
	if (ctx.hasUI && (await ctx.ui.confirm("Reload pi resources?", "Run /reload so pi picks up changed settings, context files, extensions, skills, prompts, and themes?"))) {
		await ctx.reload();
	}
}

async function runReview(pi: ExtensionAPI, ctx: ExtensionContext): Promise<SyncState> {
	const state = await inspectSyncState(pi);
	sendOutput(pi, "chezmoi sync review", renderSyncReview(state));
	await refreshStatus(pi, ctx, state);
	return state;
}

async function runPublish(pi: ExtensionAPI, ctx: ExtensionContext, scope?: string): Promise<void> {
	let state = await runReview(pi, ctx);
	let selectedScope = scope;

	if (!selectedScope && ctx.hasUI) {
		const options = ["all", "chezmoi", "pi-personal", "cancel"];
		const choice = await select(ctx, "Publish which local changes?", options);
		if (!choice || choice === "cancel") {
			notify(ctx, "publish cancelled.", "warning");
			return;
		}
		selectedScope = choice;
	}

	if (selectedScope === "chezmoi" || selectedScope === "all" || !selectedScope) {
		const addResult = await maybeAddManagedChezmoiDrift(pi, ctx, state);
		if (addResult) {
			sendOutput(pi, "chezmoi add", formatChezmoiResult("chezmoi add", ["add", ...parseManagedTargetPaths(state.managedStatus)], addResult));
			if (addResult.code !== 0) {
				notify(ctx, "chezmoi add failed; publish stopped.", "error");
				return;
			}
			state = await inspectSyncState(pi);
		}
	}

	const targets = matchPublishTargets(selectedScope, state);
	if (targets.length === 0) {
		notify(ctx, "No publishable local changes found for that scope.", "info");
		return;
	}

	const reviews = await Promise.all(targets.map((target) => renderPublishReview(pi, target)));
	const snapshotFailure = reviews.find((review) => snapshotError(review.snapshot));
	if (snapshotFailure) {
		notify(ctx, `${snapshotFailure.target.label} publish snapshot failed; publish stopped.`, "error");
		return;
	}
	sendOutput(pi, "chezmoi sync publish review", ["# Publish review", "", ...reviews.map((review) => review.body)].join("\n"));

	const ok = await confirm(ctx, "Publish local pi changes?", `Commit/rebase/push ${targets.map((target) => target.label).join(" and ")}? Review the publish diff before confirming.`);
	if (!ok) {
		notify(ctx, "publish cancelled.", "warning");
		return;
	}

	const steps: CommandStep[] = [];
	let stopped: PublishOutcome | undefined;
	for (const review of reviews) {
		const outcome = await publishRepo(pi, ctx, review);
		steps.push(...outcome.steps);
		if (outcome.status !== "succeeded") {
			stopped = outcome;
			break;
		}
	}

	if (steps.length > 0) sendOutput(pi, "chezmoi sync publish", formatStepResults("chezmoi sync publish", steps));

	if (stopped?.status === "cancelled" || stopped?.status === "stale") {
		notify(ctx, stopped.message || "publish cancelled.", "warning");
		await refreshStatus(pi, ctx);
		return;
	}

	const failed = steps.find((step) => step.result.code !== 0);
	if (stopped?.status === "failed" || failed) {
		notify(ctx, failed ? `${failed.title} failed. Resolve manually, then run /chezmoi-sync review.` : stopped?.message || "publish failed. Run /chezmoi-sync review.", "error");
		await refreshStatus(pi, ctx);
		return;
	}

	notify(ctx, "publish complete.", "info");
	await refreshStatus(pi, ctx);
}

async function handleStartup(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const state = await inspectSyncState(pi);
	await refreshStatus(pi, ctx, state);
	if (!ctx.hasUI || !hasPendingWork(state)) return;

	const options = ["Review now"];
	if (hasInbound(state)) options.push("Sync inbound now");
	if (hasOutbound(state)) options.push("Publish outbound now");
	options.push("Later");

	const choice = await select(
		ctx,
		`chezmoi sync has pending work: ${[
			hasInbound(state) ? "inbound" : undefined,
			hasOutbound(state) ? "outbound" : undefined,
			state.managedDrift ? "managed-file drift" : undefined,
		]
			.filter(Boolean)
			.join(", ")}.`,
		options,
	);

	if (choice === "Review now") await runReview(pi, ctx);
	if (choice === "Sync inbound now") await runFullSync(pi, ctx);
	if (choice === "Publish outbound now") await runPublish(pi, ctx, "all");
}

function registerSyncCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Review, sync, and publish pi config/resources through chezmoi and pi package git repos",
		handler: async (rawArgs, ctx) => {
			if (!(await hasChezmoi(pi))) {
				notify(ctx, "chezmoi is not installed or not on PATH.", "error");
				return;
			}

			const parsed = parseCommand(rawArgs);
			if ("error" in parsed) {
				notify(ctx, parsed.error, "error");
				return;
			}

			if (parsed.action === "help" || parsed.action === "--help" || parsed.action === "-h") {
				sendOutput(pi, "chezmoi-sync help", usage());
				return;
			}

			if (parsed.action === "review") {
				await runReview(pi, ctx);
				return;
			}

			if (parsed.action === "sync") {
				const ok = await confirm(ctx, "Sync pi config and packages?", "Run `chezmoi update`, then `pi update --extensions`, then offer to reload pi resources?");
				if (!ok) {
					notify(ctx, "chezmoi sync cancelled.", "warning");
					return;
				}
				await runFullSync(pi, ctx);
				return;
			}

			if (parsed.action === "publish") {
				await runPublish(pi, ctx, parsed.args[0]?.toLowerCase());
				return;
			}

			if (parsed.action === "status") {
				const args = ["status"];
				const result = await runChezmoi(pi, args, 10_000);
				sendOutput(pi, "chezmoi status", formatChezmoiResult("chezmoi status", args, result));
				notify(ctx, result.code === 0 ? (result.stdout.trim() ? "chezmoi has pending target/source changes." : "chezmoi is clean.") : "chezmoi status failed.", result.code === 0 ? "info" : "error");
				await refreshStatus(pi, ctx);
				return;
			}

			if (parsed.action === "diff") {
				const args = ["diff", ...normalizeTargets(parsed.args)];
				const result = await runChezmoi(pi, args);
				sendOutput(pi, "chezmoi diff", formatChezmoiResult("chezmoi diff", args, result));
				notify(ctx, result.code === 0 ? "chezmoi diff complete." : "chezmoi diff failed.", result.code === 0 ? "info" : "error");
				await refreshStatus(pi, ctx);
				return;
			}

			if (parsed.action === "source-path") {
				const args = ["source-path", ...normalizeTargets(parsed.args)];
				const result = await runChezmoi(pi, args, 10_000);
				sendOutput(pi, "chezmoi source-path", formatChezmoiResult("chezmoi source-path", args, result));
				notify(ctx, result.code === 0 ? "chezmoi source path shown." : "chezmoi source-path failed.", result.code === 0 ? "info" : "error");
				return;
			}

			if (parsed.action === "add-agents") {
				parsed.args = [AGENTS_TARGET];
				parsed.action = "add";
			}

			if (parsed.action === "add") {
				if (parsed.args.length === 0) {
					notify(ctx, "Usage: /chezmoi-sync add <target...>", "warning");
					return;
				}
				const targets = normalizeTargets(parsed.args);
				const ok = await confirm(ctx, "Update chezmoi source?", `Run \`${commandLine(["add", ...targets])}\`? This overwrites the chezmoi source copy from the current target file(s).`);
				if (!ok) {
					notify(ctx, "chezmoi add cancelled.", "warning");
					return;
				}
				const args = ["add", ...targets];
				const result = await runChezmoi(pi, args, MUTATING_TIMEOUT_MS);
				sendOutput(pi, "chezmoi add", formatChezmoiResult("chezmoi add", args, result));
				notify(ctx, result.code === 0 ? "chezmoi source updated." : "chezmoi add failed.", result.code === 0 ? "info" : "error");
				await refreshStatus(pi, ctx);
				return;
			}

			if (parsed.action === "apply") {
				const targets = normalizeTargets(parsed.args);
				const scope = targets.length > 0 ? targets.join(", ") : "all managed files";
				const ok = await confirm(ctx, "Apply chezmoi changes?", `Run \`${commandLine(["apply", ...targets])}\` to update ${scope}?`);
				if (!ok) {
					notify(ctx, "chezmoi apply cancelled.", "warning");
					return;
				}

				const args = ["apply", ...targets];
				const result = await runChezmoi(pi, args, MUTATING_TIMEOUT_MS);
				sendOutput(pi, "chezmoi apply", formatChezmoiResult("chezmoi apply", args, result));
				notify(ctx, result.code === 0 ? "chezmoi apply complete." : "chezmoi apply failed.", result.code === 0 ? "info" : "error");
				await refreshStatus(pi, ctx);

				if (result.code === 0 && ctx.hasUI && (await ctx.ui.confirm("Reload pi resources?", "Run /reload so pi picks up changed settings, context files, extensions, skills, prompts, and themes?"))) {
					await ctx.reload();
				}
				return;
			}

			if (parsed.action === "update") {
				const ok = await confirm(ctx, "Update chezmoi?", "Run `chezmoi update`? This pulls the chezmoi source repo and applies changes to managed files.");
				if (!ok) {
					notify(ctx, "chezmoi update cancelled.", "warning");
					return;
				}

				const args = ["update", ...parsed.args];
				const result = await runChezmoi(pi, args, MUTATING_TIMEOUT_MS);
				sendOutput(pi, "chezmoi update", formatChezmoiResult("chezmoi update", args, result));
				notify(ctx, result.code === 0 ? "chezmoi update complete." : "chezmoi update failed.", result.code === 0 ? "info" : "error");
				await refreshStatus(pi, ctx);

				if (result.code === 0 && ctx.hasUI && (await ctx.ui.confirm("Reload pi resources?", "Run /reload so pi picks up changed settings, context files, extensions, skills, prompts, and themes?"))) {
					await ctx.reload();
				}
				return;
			}

			notify(ctx, `Unknown chezmoi-sync action: ${parsed.action}`, "warning");
			sendOutput(pi, "chezmoi-sync help", usage());
		},
	});
}

export default function chezmoiSync(pi: ExtensionAPI): void {
	let startupPromptShown = false;

	pi.registerMessageRenderer(MESSAGE_TYPE, (message) => {
		const details = message.details as { body?: string } | undefined;
		const fallback = typeof message.content === "string" ? message.content : "";
		return new Text(details?.body ?? fallback, 0, 0);
	});

	registerSyncCommand(pi);

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "reload") {
			await refreshStatus(pi, ctx);
			return;
		}
		if (startupPromptShown) return;
		startupPromptShown = true;
		await handleStartup(pi, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
