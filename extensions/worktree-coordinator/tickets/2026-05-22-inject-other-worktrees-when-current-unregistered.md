# Inject other worktree awareness even when current worktree is unregistered

## Status

Implemented in `extensions/worktree-coordinator.ts`. A stopped current worktree is treated as unregistered, while stopped entries are excluded from active coordination context.

## Summary

The worktree coordinator should still warn the current session about other registered worktrees even when the current worktree has not run `/wt start`. A session on `main` should know that another branch/worktree is active, because coordination value comes from avoiding accidental ignorance of parallel work, not only from sessions that opted in first.

## Triggering case

In the Creo repository, `/Users/sejunpark/IT/creo-sub` was registered with `/wt start` on branch `sub`, but the main worktree at `/Users/sejunpark/IT/creo` was not registered. Asking the agent whether it was aware of other branches/worktrees produced no injected context until the agent manually inspected Git and `.git/pi-worktrees/state.json`.

Current extension behavior:

- `before_agent_start` calls `renderContext(...)`.
- `renderContext(...)` returns `undefined` if `currentEntry(state, git)` is missing.
- Therefore unregistered worktrees receive no context about other registered worktrees.

## Problem

This makes the extension easy to miss exactly when it is most useful: a fresh or default worktree can unknowingly work in parallel with an already registered branch. Registration should enrich the current worktree's own intent and area, but lack of registration should not suppress awareness of other active worktrees.

## Expected behavior

For an unregistered current worktree, inject a smaller advisory context when other registered worktrees exist:

- Current branch/path is not registered; suggest `/wt start <intent>`.
- List other registered worktrees with branch, intent, area if present, status, and last-seen age.
- Preserve the existing advisory rule: overlap is allowed; prefer correct design and call out integration risk.
- Do not invent an intent or implementation area for the current worktree.

## Acceptance criteria

- A session in an unregistered worktree receives injected context when at least one other active worktree is registered.
- A session in an unregistered worktree with no other registered worktrees receives no noisy injection, or only the existing UI/status behavior.
- `/wt status` remains the detailed manual view and clearly distinguishes current unregistered worktree from other registered ones.
- Registered worktrees keep the existing richer context that includes their own intent and implementation area.
- Stopped worktrees are not injected as active coordination context.

## Suggested implementation area

- `extensions/worktree-coordinator.ts`
  - Split `renderContext(...)` into registered-current and unregistered-current paths.
  - Reuse `otherEntries(...)` or add an `activeEntries(state)` branch for the unregistered case.
  - Keep context concise and capped by `MAX_CONTEXT_ITEMS`.
