# Ticket: Reduce post-review-loop output and token cost

## Problem

A recent `post-review-loop` run showed that the extension emits and stores more text than the review workflow needs. The final report is visibly long, but the larger recurring cost comes from repeated phase prompts, repeated ledger/status output, verbose validation failures, and full-state payloads in tool details/session entries.

This makes long loops expensive and noisy even when the actual code review work is modest.

## Measured example

From a 5-iteration workflow-node run review:

| Source | Visible size | Approx tokens | Notes |
| --- | ---: | ---: | --- |
| Phase prompts | 124,992 chars | ~31k | Full rules, schema reminders, and growing ledger repeated every phase. |
| `post_review_loop_get_state` outputs | 50,055 chars | ~12.5k | Often duplicates the phase prompt ledger. |
| Final report | 34,305 chars | ~8.6k | Long, but not the only issue. |
| Tool validation errors | 23,506 chars | ~5.9k | Failed submissions included full received arguments. |
| Tool `details` payloads | 684k+ chars | storage/log overhead | Full state returned in tool details. |
| Persisted state entries | 1.28M chars | storage/log overhead | Full state appended repeatedly. |

Recorded model usage for the loop was roughly 746k uncached input tokens, 7.83M cache-read tokens, 72.7k output tokens, and about $9.83 total. Not all of that is extension overhead, but extension-controlled output is a meaningful contributor.

## Main causes

1. `phasePrompt()` repeats the full ledger, full rules, and full structured-result reminders every phase.
2. `renderLedgerSummary()` keeps applied Bucket I fixes verbose in current prompts even after they are no longer actionable.
3. `renderFinalReport()` duplicates data across Summary, Bucket I, Code Changes Applied, Validation, and Rejected / Kept As-Is.
4. Validation errors from `post_review_loop_submit_phase_result` echo the full submitted arguments.
5. Tool results include full `state` in `details`, and session persistence appends full state snapshots for many events.
6. `finalReport` is stored inside loop state even though it can be rendered from the ledger.

## Proposed design

### 1. Compact phase prompts by default

Keep the model sufficiently guided, but stop repeating stable instructions and closed findings.

- Show compact header: scope, phase, iteration, last gate.
- Show only actionable/current Bucket I items in full.
- Show applied Bucket I as count plus titles only, or omit unless relevant to the phase.
- Show Bucket II current items as titles plus status only unless unresolved and relevant.
- Show validation as last 3 records or failures only.
- Replace full file lists with counts and a short list; offer full status via tool/report command.
- Include full rules/schema reminders only on the first phase or behind a `verbose` mode.

### 2. Compact `get_state` by default

Make `post_review_loop_get_state` return a short operational state by default:

- phase, iteration, last gate, blockers
- actionable Bucket I titles
- unresolved Bucket II titles
- recent failed validation, if any
- required next action

Add a full mode later if tool parameters support it, or expose full status through `/post-review-loop status --full`.

### 3. Concise final report by default

Render the final report for human reading, not as a full audit dump.

Suggested default sections:

- Summary / verdict
- What was reviewed
- Applied fixes: one compact bullet per current applied Bucket I
- Remaining decisions: Bucket II only
- Validation summary grouped by command/result
- Files changed summary

Move verbose sections to `--full`:

- full validation table
- codeChanges expanded details
- rejected/kept-as-is full list
- phase-by-phase run log
- baseline/checkpoint internals

### 4. Deduplicate and group repeated content

- Deduplicate `rejectedOrKeptAsIs` by normalized title in reports and prompts.
- Group validation rows by command/result, with count and latest note.
- Avoid repeating the same validation evidence in both Bucket I and Code Changes Applied in the concise report.
- For applied Bucket I, report `title`, `status`, and `files`; leave `revealed`, `bandageReason`, and detailed validation to full mode.

### 5. Reduce validation-error blast radius

- Make schema reminders list exact allowed Bucket II statuses.
- Consider normalizing common aliases such as `open` to `left for user decision` before validation, if safe.
- If validation fails, return only failing paths and a compact hint, not full received arguments.

### 6. Reduce state/detail bloat

- Do not include full loop state in normal tool result `details`; include a compact state summary or state id/version.
- Do not store `finalReport` inside `LoopState`; render from ledger on request.
- Consider persisting compact deltas/events instead of full state snapshots on every event, or persist full state only on phase submit/checkpoint milestones.
- Avoid duplicate persistence around `phase-submitted` and `checkpoint-queued` when the state did not materially change.

## Candidate implementation areas

- `extensions/post-review-loop/prompts.ts`
  - Add compact prompt rendering and shorter rule/schema blocks.
- `extensions/post-review-loop/report.ts`
  - Add concise vs full report renderers.
  - Group validation and deduplicate rejected items.
- `extensions/post-review-loop/index.ts`
  - Make `get_state` output compact.
  - Trim tool result `details`.
  - Add `status/report --full` command parsing if desired.
  - Reduce validation-error verbosity if possible at tool boundary.
- `extensions/post-review-loop/state.ts`
  - Avoid storing rendered final report in state.
  - Investigate delta or milestone persistence.
- `extensions/post-review-loop/ledger.ts`
  - Add helpers for compact current/actionable/applied views.

## Acceptance criteria

- A later 5-phase loop prompt sequence should be materially smaller, ideally under ~40% of the current phase-prompt character total for comparable findings.
- Default final report should be short enough to read in one screen or a few screens, ideally under ~8k chars for a typical loop with several fixes.
- Full audit detail remains accessible through an explicit full report/status path.
- Tool validation failures do not echo full submitted arguments.
- The model still receives enough context to follow the active phase without calling `get_state` every turn.
- Existing loop safety rules remain intact: no phase confusion, no unapproved Bucket II implementation, no lost validation/blocker information.

## Non-goals

- Do not remove the ledger or audit trail entirely.
- Do not make the loop rely on hidden session memory only.
- Do not change review semantics or gate decisions while reducing output.
- Do not vendor session logs or machine-local runtime state into this repository.
