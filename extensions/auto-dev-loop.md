# auto-dev-loop

Pi-first automation for the development loop: pick one task from task/plan Markdown, do the prep and implementation, run `post-review-loop`, ask for Bucket II decisions, then continue to the next task.

## Why this setup

Use Pi as the first implementation layer. This repo already has the pieces the loop needs: stateful extensions, model tools, session persistence, `post-review-loop`, compaction, and Pushover completion notifications. Codex Desktop/App Server and T3 Code are promising for future phone/remote UX, but their remote-control/mobile paths are still more experimental than the local Pi extension path.

Research notes:

- Codex App Server has strong JSON-RPC automation primitives, but remote-control/websocket paths are still experimental and need careful auth.
- T3 Code has Tailscale/remote-environment direction and a mobile app, but the mobile app is still in development rather than a dependable foundation today.
- Steipete-style automation patterns map well to this loop: one item at a time, explicit stop conditions, evidence-first validation, and minimal user clarification.

## Basic use

```text
/auto-dev once
/auto-dev start
/auto-dev status
/auto-dev pause
/auto-dev resume
/auto-dev stop
```

Useful options:

```text
/auto-dev start --once
/auto-dev start --review-limit 3
/auto-dev start --task-files TODO.md,PLAN.md,ROADMAP.md
/auto-dev start --no-compact-between-tasks
```

Answers can be typed normally when the loop is waiting, or explicitly:

```text
/auto-dev answer <clarification>
/auto-dev bucket2 <decision>
```

## Workflow contract

1. The extension asks the model to choose exactly one safe task from project task/plan Markdown files.
2. The model must inspect enough context before editing.
3. The model asks you only for product policy, public contract, user intent, taste, missing access, destructive actions, or other project-vision decisions. It should decide ordinary syntax, library API, validation, and code-organization details itself.
4. The model reports task completion through `auto_dev_task_result`.
5. The extension starts `post-review-loop` for the completed task.
6. When `post-review-loop` finishes, unresolved Bucket II items pause the loop and get presented for your decision.
7. Approved Bucket II follow-up is applied, reviewed again when it changes files, and then the loop continues to the next task.

## Phone / remote answering

Basic path: configure the existing Pushover extension.

```text
PUSHOVER_APP_TOKEN=...
PUSHOVER_USER_KEY=...
/pushover test
/pushover on
```

Pi will notify when the agent stops for an answer or when `post-review-loop` completes.

Desired path: build a small Pi RPC client exposed through Tailscale. Pi RPC already streams messages and exposes extension UI requests, so a web or Discord adapter can let you read the pending question and send a normal prompt from your phone. T3 Code and Codex remote connections are worth watching, but they should be a second phase rather than the foundation for this local workflow.

## Context reset strategy

`context-compaction-guard` remains the generic threshold advisory for ordinary sessions and mid-task work. Auto-dev-loop adds a lifecycle-aware checkpoint only at safe boundaries: after the task, `post-review-loop`, and any approved Bucket II follow-up are complete, but before the next task is injected.

When that checkpoint sees large context, it first asks the agent to produce a high-fidelity handoff with `compact_conversation` through the shared agent-compaction controller. A direct `ctx.compact(...)` call does not use `compact-custom.ts` by itself, so the agent-authored path is preferred for preserving workflow state, validation evidence, and Bucket II decisions. If that path is busy or fails, auto-dev-loop falls back to built-in `ctx.compact(...)` with auto-dev handoff instructions, then continues the loop.

`--no-compact-between-tasks` disables only this auto-dev checkpoint; it does not disable generic compaction advisories. A true fresh-session-per-task driver should still be built later as a small Pi SDK/RPC app, because extension event/tool contexts cannot safely call `/new` after every task.
