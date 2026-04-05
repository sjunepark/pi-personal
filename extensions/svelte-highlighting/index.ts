import svelteGrammar from "highlight.svelte";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type HighlightJsRuntime = {
	getLanguage(name: string): unknown;
	registerLanguage(name: string, grammar: (runtime: unknown) => unknown): void;
};

type TruncationDetails = {
	truncated?: boolean;
	firstLineExceedsLimit?: boolean;
	truncatedBy?: "lines" | "bytes";
	outputLines?: number;
	totalLines?: number;
	maxLines?: number;
	maxBytes?: number;
};

type ReadToolDetails = {
	truncation?: TruncationDetails;
};

type EditToolDetails = {
	diff?: string;
};

type ToolRenderResultOptions = {
	expanded: boolean;
	isPartial: boolean;
};

type TextComponent = {
	setText(text: string): void;
};

type TextConstructor = new (text: string, x: number, y: number) => TextComponent;

type PiRuntime = {
	DEFAULT_MAX_BYTES: number;
	DEFAULT_MAX_LINES: number;
	createEditToolDefinition(cwd: string): any;
	createReadToolDefinition(cwd: string): any;
	createWriteToolDefinition(cwd: string): any;
	formatSize(bytes: number): string;
	getLanguageFromPath(path: string): string | undefined;
	highlightCode(code: string, lang?: string): string[];
	keyHint(id: string, text: string): string;
};

type RuntimeDeps = {
	pi: PiRuntime;
	Text: TextConstructor;
	highlightJs: HighlightJsRuntime;
};

type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

const runtimeDeps = loadRuntimeDeps();
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

export default function svelteHighlighting(pi: any): void {
	registerSvelteLanguage();

	const cwd = process.cwd();
	const readTool = runtimeDeps.pi.createReadToolDefinition(cwd);
	const writeTool = runtimeDeps.pi.createWriteToolDefinition(cwd);
	const editTool = runtimeDeps.pi.createEditToolDefinition(cwd);

	pi.registerTool({
		...readTool,
		renderResult(result, options, theme, context) {
			const rawPath = getRawPath(context.args);
			if (!isSveltePath(rawPath)) {
				return readTool.renderResult(result, options, theme, context);
			}

			const text = getTextComponent(context.lastComponent);
			text.setText(
				formatReadResult(
					context.args,
					result as { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails },
					options,
					theme,
				),
			);
			return text;
		},
	});

	pi.registerTool({
		...writeTool,
		renderCall(args, theme, context) {
			const rawPath = getRawPath(args);
			if (!isSveltePath(rawPath)) {
				return writeTool.renderCall(args, theme, context);
			}

			const fileContent = getStringArg((args as { content?: unknown } | undefined)?.content);
			const component = getWriteCallRenderComponent(context.lastComponent);

			if (fileContent !== null) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath ?? "", fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath ?? "", fileContent);
			} else {
				component.cache = undefined;
			}

			component.setText(
				formatWriteCall(
					args as { path?: unknown; file_path?: unknown; content?: unknown } | undefined,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
				),
			);
			return component;
		},
	});

	pi.registerTool({
		...editTool,
		renderResult(result, options, theme, context) {
			const rawPath = getRawPath(context.args);
			if (!isSveltePath(rawPath) || context.isError) {
				return editTool.renderResult(result, options, theme, context);
			}

			const details = (result as { details?: EditToolDetails }).details;
			if (!details?.diff) {
				return editTool.renderResult(result, options, theme, context);
			}

			const text = getTextComponent(context.lastComponent);
			text.setText(`\n${renderSyntaxHighlightedDiff(details.diff, "svelte", theme)}`);
			return text;
		},
	});
}

function loadRuntimeDeps(): RuntimeDeps {
	const runtimeEntry = getRuntimeRequireTarget();
	const requireFromRuntime = createRequire(runtimeEntry);
	const pi = requireFromRuntime(join(dirname(runtimeEntry), "index.js")) as PiRuntime;
	const { Text } = requireFromRuntime("@mariozechner/pi-tui") as { Text: TextConstructor };
	const highlightJs = requireFromRuntime("highlight.js") as HighlightJsRuntime;
	return { pi, Text, highlightJs };
}

function getRuntimeRequireTarget(): string {
	const runtimeEntry = process.argv[1];
	if (runtimeEntry && runtimeEntry.includes("/")) {
		try {
			return realpathSync(runtimeEntry);
		} catch {
			return runtimeEntry;
		}
	}
	return fileURLToPath(import.meta.url);
}

function registerSvelteLanguage(): void {
	if (!runtimeDeps.highlightJs.getLanguage("svelte")) {
		runtimeDeps.highlightJs.registerLanguage("svelte", svelteGrammar as (runtime: unknown) => unknown);
	}
}

function getTextComponent(lastComponent: unknown): TextComponent {
	return (lastComponent as TextComponent | undefined) ?? new runtimeDeps.Text("", 0, 0);
}

function getWriteCallRenderComponent(lastComponent: unknown): TextComponent & { cache?: WriteHighlightCache } {
	return (lastComponent as (TextComponent & { cache?: WriteHighlightCache }) | undefined) ?? new runtimeDeps.Text("", 0, 0);
}

function getStringArg(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function getRawPath(args: { path?: unknown; file_path?: unknown } | undefined): string | undefined {
	const rawPath = getStringArg(args?.file_path ?? args?.path);
	if (rawPath === null || rawPath === "") return undefined;
	return rawPath;
}

function isSveltePath(path: string | undefined): boolean {
	return path?.toLowerCase().endsWith(".svelte") ?? false;
}

function getPreferredLanguage(path: string | undefined): string | undefined {
	if (!path) return undefined;
	return isSveltePath(path) ? "svelte" : runtimeDeps.pi.getLanguageFromPath(path);
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function highlightCode(code: string, lang?: string): string[] {
	return runtimeDeps.pi.highlightCode(code, lang);
}

function highlightSingleLine(line: string, lang: string): string {
	return highlightCode(line, lang)[0] ?? "";
}

function formatReadResult(
	args: { path?: unknown; file_path?: unknown } | undefined,
	result: { content: Array<{ type: string; text?: string }>; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: any,
): string {
	const rawPath = getRawPath(args);
	const lang = getPreferredLanguage(rawPath);
	const output = result.content
		.filter((content) => content.type === "text")
		.map((content) => normalizeDisplayText(content.text ?? ""))
		.join("\n");
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.join("\n")}`;

	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${runtimeDeps.pi.keyHint("app.tools.expand", "to expand")})`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${runtimeDeps.pi.formatSize(truncation.maxBytes ?? runtimeDeps.pi.DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? runtimeDeps.pi.DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${runtimeDeps.pi.formatSize(truncation.maxBytes ?? runtimeDeps.pi.DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}

	return text;
}

function rebuildWriteHighlightCacheFull(rawPath: string, fileContent: string): WriteHighlightCache | undefined {
	const lang = getPreferredLanguage(rawPath);
	if (!lang) return undefined;

	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = getPreferredLanguage(rawPath);
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;

	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0] ?? "";
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex] ?? "", cache.lang);

	for (let index = 1; index < segments.length; index++) {
		cache.normalizedLines.push(segments[index] ?? "");
		cache.highlightedLines.push(highlightSingleLine(segments[index] ?? "", cache.lang));
	}

	refreshWriteHighlightPrefix(cache);
	return cache;
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;

	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let index = 0; index < prefixCount; index++) {
		cache.highlightedLines[index] = prefixHighlighted[index] ?? highlightSingleLine(cache.normalizedLines[index] ?? "", cache.lang);
	}
}

function formatWriteCall(
	args: { path?: unknown; file_path?: unknown; content?: unknown } | undefined,
	options: ToolRenderResultOptions,
	theme: any,
	cache: WriteHighlightCache | undefined,
): string {
	const rawPath = getStringArg(args?.file_path ?? args?.path);
	const fileContent = getStringArg(args?.content);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${path === null ? theme.fg("error", "[invalid arg]") : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...")}`;

	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = getPreferredLanguage(rawPath ?? undefined);
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.join("\n")}`;

		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${runtimeDeps.pi.keyHint("app.tools.expand", "to expand")})`;
		}
	}

	return text;
}

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1] ?? " ", lineNum: match[2] ?? "", content: match[3] ?? "" };
}

function renderSyntaxHighlightedDiff(diffText: string, lang: string, theme: any): string {
	return diffText
		.split("\n")
		.map((line) => {
			const parsed = parseDiffLine(line);
			if (!parsed) {
				return theme.fg("toolDiffContext", line);
			}

			const colorName = parsed.prefix === "+"
				? "toolDiffAdded"
				: parsed.prefix === "-"
					? "toolDiffRemoved"
					: "toolDiffContext";
			const prefix = `${parsed.prefix}${parsed.lineNum} `;
			const highlightedContent = highlightSingleLine(replaceTabs(parsed.content), lang);
			return `${theme.fg(colorName, prefix)}${highlightedContent}`;
		})
		.join("\n");
}
