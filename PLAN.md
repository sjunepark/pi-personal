# PLAN.md

## Goal

Add a **full pi extension** that gives Svelte syntax highlighting in the places current pi misses it:

1. fenced markdown code blocks labeled `svelte`
2. `.svelte` file previews in built-in tool rendering (`read`, `write`, `edit`)

## Chosen approach

This plan has two versions:

- **v1:** ship a practical full extension using **`highlight.svelte`** on pi’s current `highlight.js`/`cli-highlight` path
- **v2:** design and, if feasible, prototype a more robust path based on the **official Svelte TextMate grammar** from `sveltejs/language-tools`

Why v1 is first:
- pi currently highlights markdown/code through a `highlight.js`/`cli-highlight` path
- `highlight.svelte` is the most direct drop-in for that path
- it keeps this as an extension, without patching pi core

Why v2 exists:
- the **official** and more robust grammar source is `sveltejs/language-tools` (`packages/svelte-vscode/syntaxes/svelte.tmLanguage.src.yaml`)
- that grammar is materially richer and closer to what users expect from VS Code
- if pi exposes a clean enough hook, or if a contained renderer override is practical, this should become the preferred long-term implementation

## Deliverables

### v1 deliverables

- `extensions/svelte-highlighting/`
  - `index.ts`
  - `package.json`
- Svelte language registration on extension load
- Built-in tool renderer overrides for `.svelte` files
- short usage notes / comments in the extension source
- validation that the extension loads in this repo’s pi package layout

### v2 deliverables

- documented evaluation of a TextMate/Shiki-based Svelte highlighting path
- decision on whether v2 can live entirely in an extension or requires pi core changes
- if feasible, a prototype or implementation plan for replacing the Svelte markdown/code rendering path with the official grammar source
- explicit notes on tradeoffs, complexity, and migration path from v1

## Implementation plan

### Phase 1 — scaffold extension package

Create a self-contained extension directory so it can have its own dependency:

- `extensions/svelte-highlighting/package.json`
- `extensions/svelte-highlighting/index.ts`

Package requirements:
- dependency on `highlight.svelte`
- dependency on `highlight.js` only if needed explicitly by module resolution
- entry wired so pi auto-discovers it from `extensions/`

## Phase 2 — register Svelte highlight grammar

At extension load:

- import the highlighter runtime used by the installed package
- import `highlight.svelte`
- register `svelte` only if it is not already registered

Target result:
- assistant markdown code fences using ```` ```svelte ```` highlight correctly

## Phase 3 — override built-in tool renderers for `.svelte`

Re-register these built-in tools while delegating execution to the originals:

- `read`
- `write`
- `edit`

Pattern:
- use the original tool definitions/execution
- keep behavior identical
- only customize renderers

Renderer behavior:
- if target path ends with `.svelte`, force language to `svelte`
- otherwise preserve normal behavior as much as practical

Notes:
- `write` already uses syntax highlighting internally for previews, but pi core does not map `.svelte` to a language, so the override should supply that missing mapping at render time
- `read` and `edit` need the same treatment for consistent `.svelte` output

## Phase 4 — make the rendering quality acceptable

Verify these Svelte-specific constructs look materially better than plain HTML:

- `<script lang="ts">`
- `<style>` / `<style lang="scss">`
- `{variable}` interpolation
- `{#if}`, `{:else}`, `{/if}`
- directives such as `on:click`, `bind:value`, `class:active`
- runes-like `$state(...)`, `$derived(...)` if the grammar catches them

If the grammar misses some constructs badly, document the gap in code comments rather than silently overfitting custom regexes into the extension.

## Phase 5 — verify local packaging and loading

Confirm the repo layout still works with:

- root `package.json` exposing `./extensions`
- pi auto-discovery of extension directories
- dependency resolution from the extension package

Validation path:
- load the extension in pi from this repo
- verify it starts without import/module errors
- verify Svelte fences and `.svelte` tool previews render with syntax colors

## Phase 6 — v2 design: official grammar path

Investigate a second-generation implementation based on the official Svelte grammar from `sveltejs/language-tools`.

Research / design tasks:
- identify the minimum runtime needed to consume the official TextMate grammar in Node
- evaluate **Shiki** versus direct **`vscode-textmate` + `vscode-oniguruma`** usage
- determine whether pi’s current extension APIs are sufficient to replace markdown/code rendering where needed
- identify which surfaces can be upgraded in-extension versus which would require pi core hooks

Output of this phase:
- concrete recommendation for v2 architecture
- clear statement of what is feasible now versus blocked on pi internals

## Phase 7 — v2 prototype or implementation plan

Depending on what Phase 6 finds:

### If feasible entirely in-extension
- prototype a TextMate/Shiki-backed renderer for Svelte markdown/code paths
- compare output quality against v1 on representative `.svelte` examples
- document performance and dependency costs

### If not feasible entirely in-extension
- write a precise upstream pi change proposal covering:
  - needed renderer/highlighter hook points
  - why v1 is insufficient
  - why official TextMate grammar support improves correctness
- keep the proposal scoped to the minimum changes required to support Svelte well

## Acceptance criteria

### v1 acceptance criteria

The v1 work is done when all of the following are true:

- a Svelte extension exists under `extensions/`
- `svelte` fenced code blocks are highlighted in assistant markdown
- `.svelte` file output from `read`, `write`, and `edit` is highlighted
- tool behavior is unchanged except for rendering
- the extension is self-contained and installable through this repo’s existing pi package layout

### v2 acceptance criteria

The v2 planning/prototyping work is done when all of the following are true:

- the official grammar source and runtime path are documented
- there is a clear decision between:
  - extension-only v2, or
  - upstream pi hook/core change
- the migration path from v1 to v2 is documented
- the expected gains and costs of v2 are written down concretely

## Non-goals for v1

- replacing pi’s markdown engine wholesale
- building a Shiki/TextMate renderer inside the extension
- achieving byte-for-byte parity with VS Code’s official Svelte TextMate grammar
- upstreaming changes into pi core yet

## v2 success target

v2 should aim for:
- much closer behavior to official VS Code Svelte highlighting
- use of the official `sveltejs/language-tools` grammar source, directly or via a faithful packaged form
- a path that is maintainable enough to keep up with future Svelte syntax changes

## Future upgrade path

If v1 works and the result is still not good enough:

1. use the findings from Phase 6 and Phase 7
2. prefer the **official** Svelte TextMate grammar from `sveltejs/language-tools`
3. implement the least invasive route that still improves correctness:
   - this extension, if pi exposes enough hooks, or
   - an upstream pi core change, if that is the cleaner long-term fix
