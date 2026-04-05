# svelte-highlighting

Project-local pi extension that adds better Svelte syntax highlighting without patching pi core.

## v1

This extension uses `highlight.svelte` to register a `svelte` language with the same `highlight.js` instance pi already uses for markdown/code highlighting.

It also overrides the built-in `read`, `write`, and `edit` renderers so `.svelte` files render as Svelte instead of falling back to plain text or generic diff coloring.

## v2 direction

The authoritative grammar source is the official Svelte VS Code extension in `sveltejs/language-tools`, specifically the TextMate grammar under `packages/svelte-vscode/syntaxes/`.

That route is better for correctness, but pi currently exposes extension hooks around tool rendering more cleanly than full markdown/highlighter replacement. Because of that:

- **v1 fits well as an extension**
- **v2 likely wants a pi core hook** for swapping markdown/code highlighting to a TextMate/Shiki-backed path

Recommended upstream/core improvements if v2 is pursued:

1. add `.svelte` to pi core `getLanguageFromPath()`
2. register a built-in Svelte grammar for the existing highlighter path
3. expose a cleaner markdown highlighter override so extensions can replace fenced-code rendering without reimplementing message rendering

Until those hooks exist, this extension intentionally stays on the least invasive path.
