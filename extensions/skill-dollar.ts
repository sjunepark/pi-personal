import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import {
	decodeKittyPrintable,
	fuzzyFilter,
	matchesKey,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
} from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

type SkillCommand = {
	skillName: string;
	description?: string;
	filePath: string;
	baseDir: string;
};

const SKILL_TOKEN_CHARS = /^[a-z0-9-]*$/;
const SKILL_MENTION_REGEX = /\$([a-z0-9][a-z0-9-]{0,63})\b/g;

function normalizeSkillName(commandName: string): string {
	return commandName.startsWith("skill:") ? commandName.slice("skill:".length) : commandName;
}

function listSkills(pi: ExtensionAPI): SkillCommand[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => ({
			skillName: normalizeSkillName(command.name),
			description: command.description,
			filePath: command.sourceInfo.path,
			baseDir: dirname(command.sourceInfo.path),
		}))
		.sort((a, b) => a.skillName.localeCompare(b.skillName));
}

function createSkillMap(pi: ExtensionAPI): Map<string, SkillCommand> {
	return new Map(listSkills(pi).map((skill) => [skill.skillName, skill]));
}

function extractSkillPrefix(textBeforeCursor: string): string | null {
	const dollarIndex = textBeforeCursor.lastIndexOf("$");
	if (dollarIndex === -1) return null;

	const prefix = textBeforeCursor.slice(dollarIndex + 1);
	if (!SKILL_TOKEN_CHARS.test(prefix)) return null;

	if (dollarIndex > 0) {
		const charBeforeDollar = textBeforeCursor[dollarIndex - 1] ?? "";
		if (!/[\s([{"'`]/.test(charBeforeDollar)) return null;
	}

	return prefix;
}

function findMentionedSkills(text: string, skills: Map<string, SkillCommand>): SkillCommand[] {
	const mentioned: SkillCommand[] = [];
	const seen = new Set<string>();

	for (const match of text.matchAll(SKILL_MENTION_REGEX)) {
		const name = match[1];
		if (!name) continue;

		const index = match.index ?? -1;
		if (index > 0) {
			const charBeforeDollar = text[index - 1] ?? "";
			if (charBeforeDollar === "\\") continue;
			if (!/[\s([{"'`]/.test(charBeforeDollar)) continue;
		}

		const skill = skills.get(name);
		if (!skill || seen.has(name)) continue;

		seen.add(name);
		mentioned.push(skill);
	}

	return mentioned;
}

function renderExplicitSkillBlock(skill: SkillCommand): string {
	const content = readFileSync(skill.filePath, "utf8").trim();
	return [
		"<skill>",
		`<name>${skill.skillName}</name>`,
		`<path>${skill.filePath}</path>`,
		`<directory>${skill.baseDir}</directory>`,
		content,
		"</skill>",
	].join("\n");
}

function renderExplicitSkillMessage(skills: SkillCommand[]): string {
	return [
		"The user explicitly invoked the following skills with $ mentions for this turn.",
		"Use all of them for this request.",
		"Treat these as explicit skill instructions, separate from the user's message.",
		"When a skill references relative paths, resolve them against the listed <directory>.",
		"",
		...skills.flatMap((skill, index) => (index === 0 ? [renderExplicitSkillBlock(skill)] : ["", renderExplicitSkillBlock(skill)])),
	].join("\n");
}

class SkillDollarAutocompleteProvider implements AutocompleteProvider {
	constructor(
		private readonly delegate: AutocompleteProvider,
		private readonly getSkills: () => SkillCommand[],
	) {}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const prefix = extractSkillPrefix(textBeforeCursor);
		if (prefix === null) {
			return this.delegate.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		const skills = this.getSkills();
		if (skills.length === 0) return null;

		const items = fuzzyFilter(skills, prefix, (skill) => skill.skillName).map<AutocompleteItem>((skill) => ({
			value: skill.skillName,
			label: skill.skillName,
			description: skill.description,
		}));
		if (items.length === 0) return null;

		return { items, prefix };
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (extractSkillPrefix(textBeforeCursor) === null) {
			return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		}

		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const newLine = `${beforePrefix}${item.value} ${afterCursor}`;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length + 1,
		};
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.delegate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}
}

class SkillDollarEditor extends CustomEditor {
	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private readonly getSkills: () => SkillCommand[],
	) {
		super(tui, theme, keybindings);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(new SkillDollarAutocompleteProvider(provider, this.getSkills));
	}

	override handleInput(data: string): void {
		if (!this.isShowingAutocomplete() && matchesKey(data, "tab") && this.isInSkillContext()) {
			this.triggerAutocomplete(true);
			return;
		}

		const hadAutocomplete = this.isShowingAutocomplete();
		super.handleInput(data);

		if (this.isShowingAutocomplete()) return;
		if (hadAutocomplete) return;

		const printable = decodeKittyPrintable(data) ?? this.getPrintableCharacter(data);
		if (printable) {
			if ((printable === "$" || /[a-z0-9-]/i.test(printable)) && this.isInSkillContext()) {
				this.triggerAutocomplete();
			}
			return;
		}

		if ((matchesKey(data, "backspace") || matchesKey(data, "delete")) && this.isInSkillContext()) {
			this.triggerAutocomplete();
		}
	}

	private getPrintableCharacter(data: string): string | undefined {
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			return data;
		}
		return undefined;
	}

	private isInSkillContext(): boolean {
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		return extractSkillPrefix(currentLine.slice(0, col)) !== null;
	}

	private triggerAutocomplete(explicitTab = false): void {
		(
			this as unknown as {
				tryTriggerAutocomplete(explicitTab?: boolean): void;
			}
		).tryTriggerAutocomplete(explicitTab);
	}
}

export default function skillDollar(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new SkillDollarEditor(tui, theme, keybindings, () => listSkills(pi)));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!event.prompt.includes("$")) return;

		const skills = createSkillMap(pi);
		const mentionedSkills = findMentionedSkills(event.prompt, skills);
		if (mentionedSkills.length === 0) return;

		const loadedSkills: SkillCommand[] = [];
		for (const skill of mentionedSkills) {
			try {
				readFileSync(skill.filePath, "utf8");
				loadedSkills.push(skill);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to load $${skill.skillName}: ${message}`, "warning");
			}
		}
		if (loadedSkills.length === 0) return;

		return {
			message: {
				customType: "skill-dollar-explicit-skills",
				content: renderExplicitSkillMessage(loadedSkills),
				display: false,
			},
		};
	});
}
