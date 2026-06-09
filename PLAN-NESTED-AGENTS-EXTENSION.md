# Nested AGENTS.md extension

## Goal

Implement a Pi extension that lazily loads nested, path-scoped `AGENTS.md` instructions when the main session interacts with files under those scopes. The extension should make local instructions available only after relevant file paths are encountered, while avoiding branch-name or worktree-name heuristics.

## Handoff summary

The planned extension observes main-thread file tool calls, resolves their target paths inside the current git worktree, discovers `AGENTS.md` files from the git root down to each target path, and injects all newly relevant instructions before the next model turn. The chosen behavior is Option A: a cumulative active set for the current extension runtime/session. Once a nested `AGENTS.md` is loaded, it remains active until the session/runtime resets.

The extension should not physically edit Pi's root/global `AGENTS.md`. Static extension guidance should be injected once per session/branch as a hidden, tagged custom message, with duplicate detection when resuming or reloading a session. Active nested instructions should be injected as a single tagged synthetic context block generated from the current active set, not persisted repeatedly.

A short subagent guidance block is desirable because subagent tool calls do not propagate their discovered nested instructions back to the main thread: use read-only subagents to inspect unrelated modules when the main thread does not need their local rules, and touch/read a module path in the main thread when the main thread will act on it.

## Decisions already made

- Use cumulative loading: `activeInstructions = activeInstructions ∪ newlyDiscoveredInstructions`.
- Do not implement a clear command for the MVP; cumulative behavior is the feature contract.
- Scope discovery by actual file/tool target path only.
- Use the current git worktree root as the only project boundary for the MVP.
- Disable nested discovery outside git worktrees instead of falling back to `ctx.cwd`; this is less effective but more stable.
- Do not rely on branch names, worktree directory names, current working directory shape, or other naming heuristics.
- Use `tool_call` to observe file paths and `context` to inject newly relevant instructions before the next LLM request.
- Do not use `before_agent_start` alone for nested instruction injection, because it only runs once before the user prompt's agent loop.
- Start with reliable built-in file tools only: `read.path`, `edit.path`, and `write.path`.
- Defer bash-command path inference; shell parsing is too heuristic for the MVP.
- Preserve file provenance in injected content.
- Concatenate discovered instructions broad-to-local.
- Cache file contents by `mtime` and reread when the file changes.
- Inject extra subagent guidance once per session/branch as an extension-owned hidden custom message wrapped in tags, not by mutating existing `AGENTS.md` files or doing string surgery inside Pi's `<project_context>` block.
- Do not append static guidance on every user prompt.
- Subagent reads do not update the main thread's active nested `AGENTS.md` set; this limitation is acceptable and can be used intentionally for context isolation.

## Scope

### In scope

- New Pi extension source under `extensions/`.
- Discover nested `AGENTS.md` / `AGENTS.MD` files along the ancestor chain from git root to a touched file's parent directory.
- Disable nested discovery outside git worktrees and report that state in `/nested-agents`.
- Track a cumulative active set of discovered instruction files for the main extension runtime/session.
- Inject active nested instructions before provider requests via the `context` event.
- Avoid duplicating context files Pi already loaded at startup.
- Skip generated/noisy paths such as `.git`, `node_modules`, `.tmp`, `out`, build output, and caches.
- Add an inspection command, likely `/nested-agents`, showing active instruction files and the target paths that caused them to load.
- Add concise one-time tagged guidance explaining when to use subagents to keep unrelated module rules/context out of the main thread.
- Add tests for pure path discovery/filtering/cache-format helpers where practical.

### Out of scope

- `/nested-agents clear` or other manual scope-reset behavior.
- Bash command path inference.
- `CLAUDE.md` support.
- Imports/includes inside `AGENTS.md`.
- Override files or override semantics.
- Claude-style path rules/frontmatter.
- Cross-session, resumed-session, or `/reload` persistence of the active nested instruction set unless implementation discovers this is trivial and clearly safe.
- Non-git project root guessing or `ctx.cwd` fallback root discovery.
- Automatic propagation of subagent-discovered instructions back to the main thread.

## Implementation plan

- [x] Confirm the exact extension APIs and message shapes for `tool_call`, `context`, `before_agent_start`, and commands from the installed Pi docs/types.
- [x] Create a new extension file under `extensions/`, likely `extensions/nested-agents.ts`.
- [x] On `session_start`, determine the project root with `git rev-parse --show-toplevel`; if it fails, mark nested discovery inactive for this session/runtime.
- [x] Capture the context files Pi already loaded from `ctx.getSystemPromptOptions()` or `before_agent_start` `systemPromptOptions` so nested injection does not duplicate root/global files.
- [x] Implement path normalization for built-in file tools: strip leading `@`, resolve relative paths against `ctx.cwd`, reject paths outside the project root, and reject ignored/noisy path segments.
- [x] Implement ancestor-chain discovery from project root to target file parent, checking for `AGENTS.md` and `AGENTS.MD` at each directory.
- [x] Implement an mtime cache: stat each discovered instruction file, reuse content when `mtimeMs` is unchanged, and reread changed files.
- [x] Track active instruction files cumulatively with provenance: instruction path, content, first triggering target path, and latest triggering target path if useful.
- [x] Hook `tool_call` for `read`, `edit`, and `write` to discover and activate any relevant nested instruction files before the tool executes.
- [x] Hook `context` to inject a single tagged synthetic instruction message containing all active nested instructions in broad-to-local order.
- [x] Ensure the active-instruction context injection is non-persistent and does not accumulate duplicate synthetic messages across provider calls.
- [x] Hook `before_agent_start` to inject the static subagent guidance once as a hidden tagged custom message, only if the current session branch does not already contain the marker custom message.
- [x] Register `/nested-agents` to inspect active instruction files, triggering paths, cache status, and ignored paths if useful.
- [x] Add focused tests for path filtering, ancestor discovery ordering, duplicate suppression against already-loaded context files, and mtime cache refresh behavior.
- [x] Update `TODO.md` by removing or refining the completed nested-AGENTS task once implementation is done.

## Likely files and areas

- `extensions/nested-agents.ts`: likely new extension entrypoint.
- `tests/nested-agents.test.mjs`: likely new tests for pure helper behavior.
- `package.json`: confirms extensions are loaded from `./extensions` and exposes `npm test`; likely does not need changes.
- `TODO.md`: contains the existing nested-AGENTS task and should be updated after implementation.
- Pi docs/types under `/Users/sejunpark/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` and `dist/core/extensions/types.d.ts`: reference for extension events, command context, and context injection behavior.

## Validation

Run these when relevant:

```bash
npm test
git diff --check
```

No configured TypeScript build/typecheck command was identified yet. `bun build extensions/nested-agents.ts --outfile /tmp/nested-agents-extension.js --external @earendil-works/pi-coding-agent --target node` can validate that the extension entrypoint bundles successfully.

## Risks and edge cases

- Cumulative loading can grow prompt size and keep sibling module rules active after work shifts elsewhere.
- Local instructions from different scopes may conflict; provenance wrappers should make scope and origin clear.
- `context` injection must avoid duplicate active-instruction blocks within a single outgoing message list while still making active instructions available on every model request after discovery.
- The extension must not duplicate Pi's startup-loaded global/root `AGENTS.md` files.
- Tool paths may be directories, nonexistent files, symlinks, or contain leading `@`; normalize defensively.
- Non-git projects will not receive nested discovery in the MVP by design; this favors stable project boundaries over broader coverage.
- File paths outside the project root should be ignored to avoid leaking unrelated instructions.
- Subagent tool calls are isolated from the main extension state; this is intentional but should be documented in injected guidance.
- Reloading extensions or resuming sessions may reset in-memory active instructions in the MVP.

## Open questions

None for the MVP. Resolved decisions: disable nested discovery outside git worktrees, inject static subagent guidance once per session/branch as a hidden tagged custom message, and inject active nested instructions via a tagged non-persistent `context` block.

## Progress notes

- Completed implementation in `extensions/nested-agents.ts` with shared helpers in `extensions/shared/nested-agents.ts`.
- Added `tests/nested-agents.test.mjs` covering path normalization, ignored path rejection, broad-to-local discovery, duplicate suppression for startup context files, cumulative activation, mtime refresh, and extension-owned message filtering.
- Updated `TODO.md` to remove the completed nested-AGENTS task.
- Validation passed:
  - `npm test`
  - `bun build extensions/nested-agents.ts --outfile /tmp/nested-agents-extension.js --external @earendil-works/pi-coding-agent --target node`
  - `git diff --check`
- Current status: MVP complete. Next practical step is to dogfood `/nested-agents` in a Pi session and watch for prompt growth or unexpected scope conflicts.

## Next command

```text
# MVP complete; no next /progress-run command is required.
```
