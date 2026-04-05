/*
Vendored from: https://github.com/coctostan/pi-agent-browser
Upstream commit: d15f756ea63df797df8e241bdb3b4f8be71619fd (2026-02-09)
Imported: 2026-04-05
Local changes:
- Removed auto-install and Chromium download behavior; this extension now requires a preinstalled, separately trusted `agent-browser` CLI.
- Added shell-style command parsing so quoted arguments survive `pi.exec()`.

MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const TOOL_DESCRIPTION = `Browser automation via the agent-browser CLI.
Workflow: open URL -> snapshot -i (get @refs like @e1) -> interact -> re-snapshot after page changes.
Commands:
  open <url> - Navigate to URL
  snapshot -i - Interactive elements with @refs (re-snapshot after navigation)
  click <@ref> - Click element
  fill <@ref> <text> - Clear and type
  type <@ref> <text> - Type without clearing
  select <@ref> <value> - Select dropdown
  press <key> - Press key (Enter, Tab, etc.)
  scroll <dir> [px] - Scroll (up/down/left/right)
  get text|url|title [@ref] - Get information
  wait <@ref|ms> - Wait for element or time
  screenshot [--full] - Take screenshot (image returned inline)
  close - Close browser
Any valid agent-browser command works.`;
const EXEC_TIMEOUT_MS = 60_000;
const AGENT_BROWSER_INSTALL_HINT = [
	"agent-browser is not installed.",
	"Install and provision it manually before using this vendored extension:",
	"  npm install -g agent-browser",
	"  agent-browser install",
].join("\n");

type ParsedCommand =
	| { args: string[] }
	| { error: string };

function writeTempFile(content: string, prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-browser-${prefix}-`));
	const file = join(dir, "output.txt");
	writeFileSync(file, content);
	return file;
}

function parseCommand(command: string): ParsedCommand {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	let tokenStarted = false;

	for (const char of command) {
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

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			tokenStarted = true;
			continue;
		}

		if (/\s/.test(char)) {
			if (tokenStarted) {
				args.push(current);
				current = "";
				tokenStarted = false;
			}
			continue;
		}

		current += char;
		tokenStarted = true;
	}

	if (escaping) {
		current += "\\";
	}

	if (quote) {
		return {
			error: `Unterminated ${quote === '"' ? "double" : "single"} quote in browser command.`,
		};
	}

	if (tokenStarted) {
		args.push(current);
	}

	if (args.length === 0) {
		return { error: "Browser command is empty." };
	}

	return { args };
}

async function hasAgentBrowser(pi: ExtensionAPI): Promise<boolean> {
	const check = await pi.exec("which", ["agent-browser"], { timeout: 5_000 });
	return check.code === 0 && check.stdout.trim().length > 0;
}

function getMimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

function screenshotPathFromOutput(output: string): string | undefined {
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const match = lines[index].match(/saved to (.+)$/i);
		if (match) return match[1].trim();
	}

	return undefined;
}

export default function agentBrowserExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser",
		label: "Browser",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Interact with web pages through a persistent agent-browser session, including snapshots, clicks, form filling, and screenshots.",
		promptGuidelines: [
			"Use browser open <url> to navigate, browser snapshot -i to get @refs, then interact with those @refs.",
			"After clicks, fills, or navigation changes, run browser snapshot -i again before choosing the next interaction.",
			"Use browser screenshot only when a visual check matters; close the session when done.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "agent-browser command (without the 'agent-browser' prefix)" }),
		}),

		renderCall(args: { command: string }, theme: any) {
			const text = theme.fg("toolTitle", theme.bold("browser ")) + theme.fg("accent", args.command);
			return new Text(text, 0, 0);
		},

		renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Running..."), 0, 0);
			}

			const details = result.details || {};
			if (result.isError || details.error) {
				const errorText = details.error || result.content?.[0]?.text || "Error";
				return new Text(theme.fg("error", errorText), 0, 0);
			}

			const action = details.action || "";
			const content = result.content?.[0]?.text || "";

			if (action === "screenshot") {
				return new Text(theme.fg("success", `Screenshot saved: ${details.screenshotPath || "unknown"}`), 0, 0);
			}

			if (action === "snapshot") {
				const refCount = (content.match(/@e\d+/g) || []).length;
				let text = theme.fg("success", `${refCount} interactive elements`);
				if (details.truncated) {
					text += theme.fg("warning", " (truncated)");
				}
				if (expanded) {
					text += "\n" + theme.fg("dim", content);
				}
				return new Text(text, 0, 0);
			}

			if (expanded) {
				return new Text(theme.fg("dim", content), 0, 0);
			}

			const firstLine = content.split("\n")[0] || "(no output)";
			const truncated = content.includes("\n") ? "…" : "";
			return new Text(theme.fg("dim", firstLine + truncated), 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const installed = await hasAgentBrowser(pi);
			if (!installed) {
				if (ctx.hasUI) {
					ctx.ui.notify("agent-browser is not installed; manual install required.", "error");
				}
				return {
					content: [{ type: "text", text: AGENT_BROWSER_INSTALL_HINT }],
					details: { error: AGENT_BROWSER_INSTALL_HINT },
					isError: true,
				};
			}

			const commandStr = params.command.trim();
			const parsed = parseCommand(commandStr);
			if ("error" in parsed) {
				return {
					content: [{ type: "text", text: parsed.error }],
					details: { error: parsed.error, command: commandStr },
					isError: true,
				};
			}

			const action = (parsed.args[0] || "").toLowerCase();
			const result = await pi.exec("agent-browser", parsed.args, {
				signal,
				timeout: EXEC_TIMEOUT_MS,
			});

			if (result.code !== 0) {
				const errorOutput = (result.stderr || result.stdout).trim();
				return {
					content: [{ type: "text", text: errorOutput || `Command failed with exit code ${result.code}` }],
					details: { error: errorOutput, exitCode: result.code, command: commandStr },
					isError: true,
				};
			}

			const output = result.stdout.trim();
			if (action.toLowerCase() === "screenshot") {
				const screenshotPath = screenshotPathFromOutput(output);
				if (screenshotPath) {
					try {
						const imageData = readFileSync(screenshotPath);
						return {
							content: [
								{ type: "text", text: `Screenshot saved: ${screenshotPath}` },
								{ type: "image", data: imageData.toString("base64"), mimeType: getMimeType(screenshotPath) },
							],
							details: { command: commandStr, action, screenshotPath },
						};
					} catch (error: any) {
						return {
							content: [{ type: "text", text: `Screenshot saved to ${screenshotPath} but could not read file: ${error.message}` }],
							details: { command: commandStr, action, screenshotPath, readError: error.message },
						};
					}
				}
			}

			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			let resultText = truncation.content;

			if (truncation.truncated) {
				const tempFile = writeTempFile(output, action || "output");
				resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText || "(no output)" }],
				details: { command: commandStr, action, truncated: truncation.truncated },
			};
		},
	});

	pi.on("session_shutdown", async () => {
		try {
			await pi.exec("agent-browser", ["close"], { timeout: 5_000 });
		} catch {
			// Browser may already be closed or unavailable.
		}
	});
}
