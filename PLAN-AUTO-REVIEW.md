# Auto-review extension

## Goal

Implement a Pi extension like `/auto-dev`, but for long-running codebase review. It should continuously review the repository, apply only obvious safe fixes, ask the user for design/refactor decisions, keep a review ledger so it does not repeat recent work, and support phone-friendly interaction through Remote Pi.

## Handoff summary

The desired extension is tentatively `/auto-review`. It should be a ledger-driven review orchestrator, not a development task picker. It should select one review slice at a time, inspect the real code, classify findings, and then either apply a narrow obvious fix or ask the user for a decision when the issue implies design judgment, code smell, or larger refactoring.

The existing `review-campaign` skill has useful concepts to reuse: area × dimension review matrix, stale detection by commit, ledger-first behavior, `auto` vs `triage`, and avoiding repeated review of recently reviewed cells. The new extension should replace the manual skill workflow with an extension-controlled loop, state machine, phone-friendly prompts, and integration with `post-review-loop` after code edits.

Remote phone interaction should initially use `https://github.com/jacobaraujo7/remote_pi` rather than building a new mobile layer. Remote Pi supports a mobile app, QR pairing, daemon mode, scheduled prompts, and sending prompts to background Pi agents. Important security caveat: its canonical protocol documentation says the relay can see message contents because payloads are not end-to-end encrypted in the current version. Use a self-hosted relay, preferably behind Tailscale/WireGuard, for sensitive repositories.

When `/auto-review` edits code, it should start the existing `post-review-loop` programmatically as an independent self-review gate. If that loop finishes with no unresolved Bucket II items and no actionable Bucket I items, `/auto-review` may continue automatically. If Bucket II decisions or still-actionable Bucket I items remain, `/auto-review` should pause and ask the user.

## Decisions already made

- Build a new extension, likely named `/auto-review`, instead of modifying `/auto-dev`.
- Use Remote Pi as the initial phone/mobile interaction transport; do not build a custom mobile UI first.
- Keep prompts phone-friendly: short summaries, numbered choices, and support for plain-text answers rather than requiring slash commands for every response.
- Use a persistent ledger so review history survives session context loss and prevents repeated review of recently reviewed areas/dimensions.
- Reuse the existing `post-review-loop` after every code edit, using its programmatic start event rather than slash-command text.
- Let `post-review-loop` remain the independent safety gate for edited code: Bucket I/Bucket II semantics, validation, final selective commit behavior, and review preferences should not be duplicated inside `/auto-review`.
- Auto-fix eligibility for `/auto-review` should be stricter than generic Bucket I: only tiny, obvious, local changes with no design debate or larger smell.
- Findings that imply ownership/boundary issues, type/schema design, lifecycle hazards, over/under-abstraction, integration contracts, or other larger design concerns should be presented to the user for discussion.
- Branch freshness/merge checks should happen at safe checkpoints after review/fix cycles, not before every review.
- Merges/rebases should require explicit user approval; `/auto-review` should not silently merge branches.

## Scope

### In scope

- New `/auto-review` command surface with at least start/once/status/pause/resume/stop/answer behavior.
- A review loop that chooses one review slice at a time and avoids repeating recent completed slices unless code changed.
- Ledger/state persistence for review slices, findings, user decisions, applied fixes, validations, branch/commit context, and post-review outcomes.
- Finding classification into auto-fix, ask-user, and keep-as-is/record-only outcomes.
- Safe auto-fix path for obvious local issues.
- Programmatic `post-review-loop` start after `/auto-review` applies code edits.
- Waiting for the tracked post-review-loop lifecycle to become complete before continuing.
- Pausing and asking the user when post-review-loop reports unresolved Bucket II decisions or still-actionable Bucket I work.
- Phone-friendly decision prompts and plain user-input handling.
- Branch freshness checks at safe checkpoints, with user approval before merge/rebase work.
- Tests for pure ledger/state/prompt helpers where practical.

### Out of scope

- Building a custom mobile app or web UI.
- Replacing Remote Pi internals.
- Automatically merging or rebasing without explicit user approval.
- Automatically implementing design/refactor decisions without user approval.
- Broad codebase refactors as part of the initial extension implementation.
- Full migration/removal of the existing `review-campaign` skill before the extension is proven.

## Implementation plan

- [x] Read the existing `/auto-dev` extension and shared helpers to mirror the command/state/prompt architecture where useful.
- [x] Read the existing `post-review-loop` event API and lifecycle handling, especially programmatic start, lifecycle restore, Bucket II extraction, and finalizing behavior.
- [x] Define `/auto-review` state types and lifecycle states, using `active_reviewing`, `self_reviewing`, `awaiting_user`, `paused`, and `complete` for the first implementation.
- [x] Define the ledger format and location: repo-local `reviews/auto-review/` with `state.json`, `ledger.jsonl`, and `decisions.md` written best-effort at runtime.
- [x] Implement pure shared helpers for review slice selection, finding classification shapes, ledger state rendering, status rendering, and phone-friendly prompts.
- [x] Add the `/auto-review` command with `start`, `once`, `status`, `pause`, `resume`, `stop`, `clear`, and `answer <text>` behavior.
- [x] Implement one-cycle review prompting: select a slice, ask the agent to inspect real files, classify findings, and report through `auto_review_result`.
- [x] Implement auto-fix handling only for narrow obvious findings, including validation summary collection.
- [x] After any auto-fix, emit `POST_REVIEW_LOOP_START_EVENT` with a scoped review request and track the returned loop id.
- [x] Implement self-review wait/resume logic: target the tracked post-review-loop id; wait through non-complete lifecycles; continue only after the tracked loop is `complete`.
- [x] After self-review completion, extract unresolved Bucket II items and actionable Bucket I items; ask the user if any remain, otherwise continue automatically.
- [x] Implement plain user input handling while awaiting decisions so Remote Pi users can answer with numbers or short text.
- [x] Add safe-checkpoint branch freshness detection and prompt the user before merge/rebase work.
- [x] Add focused tests for shared state/ledger/prompt helpers and run existing repo validation.
- [x] Document `/auto-review` usage, safety rules, phone/Remote Pi assumptions, and ledger behavior.

## Likely files and areas

- `extensions/auto-review-loop.ts`: new `/auto-review` extension entry point, command handler, runtime state orchestration, ledger file writes, result tool, and post-review-loop integration.
- `extensions/shared/auto-review-loop.ts`: new pure helper module for state, start args, slice selection, prompts, status, ledger snapshots, and post-review issue extraction.
- `extensions/auto-review-loop.md`: new user-facing docs for usage, safety rules, ledger files, phone behavior, and current limitations.
- `extensions/auto-dev-loop.ts`: existing long-running loop architecture mirrored for commands, lifecycle, persistence, follow-up prompts, and post-review-loop integration.
- `extensions/shared/auto-dev-loop.ts`: pure helper organization and tests pattern mirrored for `/auto-review`.
- `extensions/auto-dev-loop.md`: documentation pattern for a loop extension.
- `extensions/post-review-loop/events.ts`: programmatic start event API (`POST_REVIEW_LOOP_START_EVENT`) to reuse after auto-review edits code.
- `extensions/post-review-loop/index.ts`: lifecycle behavior, final gate behavior, tools, and event registration to understand before integration.
- `extensions/post-review-loop/prompts.ts`: source of existing review preferences and Bucket I/Bucket II instructions to preserve rather than duplicate loosely.
- `extensions/post-review-loop/types.ts`: Bucket I/Bucket II/design-signal types and lifecycle types.
- `extensions/post-review-loop/ledger.ts`: helpers for current Bucket I/Bucket II state and unresolved decision extraction.
- `tests/auto-review-loop.test.mjs`: new tests for auto-review state, args, slice selection, prompts, scope rendering, and post-review issue helpers.
- `tests/auto-dev-loop.test.mjs`: testing style for pure extension helpers.
- `package.json`: existing validation scripts and package conventions.
- `reviews/auto-review/`: proposed repo-local ledger directory; confirm before implementation if repository pollution is a concern.
- Remote Pi reference: `https://github.com/jacobaraujo7/remote_pi`, especially `README.md`, `pi-extension/README.md`, `relay/README.md`, and `PROTOCOL.md` for phone transport assumptions and security caveats.

## Validation

Run these when relevant:

```bash
npm test
bun build extensions/auto-review-loop.ts --outfile=/tmp/auto-review-loop.js --target=node --format=esm
bun build extensions/post-review-loop/index.ts --outfile=/tmp/post-review-loop.js --target=node --format=esm
git diff --check
```

The auto-review build command assumes the new extension entry is `extensions/auto-review-loop.ts`; adjust if the implementation chooses a different file name.

## Risks and edge cases

- Remote Pi public relay can expose message contents to the relay operator; recommend self-hosting behind VPN for sensitive repositories.
- Phone interaction through Remote Pi sends normal user messages, so `/auto-review` must handle plain answers while awaiting decisions.
- Concurrent or pre-existing `post-review-loop` instances may block programmatic start; `/auto-review` should pause/report rather than replacing another loop silently.
- `post-review-loop` can enter `finalizing`; `/auto-review` must not treat it as complete until final commit handling finishes.
- Ledger merge conflicts are possible if the ledger is committed and branches diverge.
- Review slice selection can become noisy if stale detection is too broad or too narrow.
- Auto-fix rules must stay conservative; design-smell findings should be user decisions, not silent edits.
- Branch freshness checks before every review would reduce unattended value; keep them at safe checkpoints.
- Merge/rebase work can create semantic conflicts and should require explicit approval.
- Validation may be expensive in some repositories; ledger should record what was run and whether validation was skipped, failed, or reused.

## Open questions

- None blocking the initial implementation.
- Future enhancement: add file-fingerprint staleness detection so changed cells can be re-reviewed instead of relying only on completed slice history.
- Future enhancement: make review areas configurable beyond the built-in defaults.
- Future enhancement: decide whether to migrate or interoperate with existing `review-campaign` ledger files.

## Progress notes

- 2026-06-12: Implemented the initial `/auto-review` extension and shared helper module.
  - Added `/auto-review start|once|status|pause|resume|stop|clear|answer`.
  - Added `auto_review_result` for clean/fixed/needs_user/blocked/no_target review outcomes.
  - Added conservative auto-fix prompting and post-review-loop integration after edits.
  - Added tracked self-review completion handling for unresolved Bucket II and actionable Bucket I items.
  - Added plain input handling for phone-friendly decisions.
  - Added best-effort repo-local ledger writes under `reviews/auto-review/` at runtime.
  - Added upstream-only safe-checkpoint branch freshness prompts.
  - Added docs in `extensions/auto-review-loop.md` and tests in `tests/auto-review-loop.test.mjs`.
- 2026-06-12 validation:
  - `npm test` passed: 46/46 tests. Existing `MODULE_TYPELESS_PACKAGE_JSON` warnings remain.
  - `bun build extensions/auto-review-loop.ts --outfile=/tmp/auto-review-loop.js --target=node --format=esm` passed.
  - `bun build extensions/post-review-loop/index.ts --outfile=/tmp/post-review-loop.js --target=node --format=esm` passed.
  - `git diff --check` passed.
- Current status: initial plan implementation is complete. Remaining items are future enhancements, not blockers.

## Next command

```text
/progress-run PLAN-AUTO-REVIEW.md
```
