import type { ChecklistPhase } from "../../tools/checklist";
import {
	applyOpsToPhases,
	getLatestChecklistPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveChecklistMarkdownPath,
	USER_CHECKLIST_EDIT_CUSTOM_TYPE,
} from "../../tools/checklist";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

type ChecklistMutationVerb = "done" | "drop" | "rm";

interface ChecklistTaskMatch {
	task: { content: string; status: string };
	phase: ChecklistPhase;
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	for (let index = 0; index < input.length; index++) {
		const ch = input[index];
		if (ch === "\\" && index + 1 < input.length) {
			current += input[++index];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function titleCaseWords(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function titleCaseSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function findPhaseFuzzy(phases: ChecklistPhase[], query: string): ChecklistPhase | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	const exact = phases.find(phase => phase.name.toLowerCase() === normalizedQuery);
	if (exact) return exact;
	const prefixMatches = phases.filter(phase => phase.name.toLowerCase().startsWith(normalizedQuery));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter(phase => phase.name.toLowerCase().includes(normalizedQuery));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: ChecklistPhase[], query: string): ChecklistTaskMatch | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === normalizedQuery) return { task, phase };
		}
	}
	const matches: ChecklistTaskMatch[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(normalizedQuery)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	const active = matches.filter(match => match.task.status === "in_progress" || match.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

function currentPhases(runtime: SlashCommandRuntime): ChecklistPhase[] {
	const fromEntries = getLatestChecklistPhasesFromEntries(runtime.sessionManager.getBranch());
	return fromEntries.length > 0 ? fromEntries : runtime.session.getChecklistPhases();
}

function commitChecklist(runtime: SlashCommandRuntime, phases: ChecklistPhase[]): void {
	runtime.session.setChecklistPhases(phases);
	runtime.sessionManager.appendCustomEntry(USER_CHECKLIST_EDIT_CUSTOM_TYPE, { phases });
}

const CHECKLIST_HELP_TEXT = [
	"Usage: /checklist <verb> [args]",
	"  /checklist                              Show current checklist items",
	"  /checklist edit                         (TUI only) open in $EDITOR",
	"  /checklist copy                         Print checklist items as Markdown",
	"  /checklist export [<path>]              Write checklist items to file (default: CHECKLIST.md)",
	"  /checklist import [<path>]              Replace checklist items from file (default: CHECKLIST.md)",
	"  /checklist append [<phase>] <task...>   Append a task",
	"  /checklist start  <task>                Mark task in_progress (fuzzy match)",
	"  /checklist done   [<task|phase>]        Mark task/phase/all completed",
	"  /checklist drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /checklist rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

async function handleChecklistCopyCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
	await runtime.output(`Copy not available in ACP mode; printing instead:\n\n${markdown || "No checklist items."}`);
	return commandConsumed();
}

async function handleChecklistExportCommand(
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const phases = currentPhases(runtime);
	if (phases.length === 0) {
		await runtime.output("No checklist items to export.");
		return commandConsumed();
	}
	let target: string;
	try {
		target = resolveChecklistMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		await Bun.write(target, phasesToMarkdown(phases));
	} catch (err) {
		return usage(`Failed to write items: ${errorMessage(err)}`, runtime);
	}
	await runtime.output(`Wrote checklist items to ${target}`);
	return commandConsumed();
}

async function handleChecklistImportCommand(
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	let target: string;
	let content: string;
	try {
		target = resolveChecklistMarkdownPath(restArgs, runtime.sessionManager.getCwd());
		content = await Bun.file(target).text();
	} catch (err) {
		return usage(`Failed to read items: ${errorMessage(err)}`, runtime);
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0) return usage(`Could not parse ${target}:\n  ${errors.join("\n  ")}`, runtime);
	commitChecklist(runtime, phases);
	const taskCount = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	await runtime.output(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${target}.`);
	return commandConsumed();
}

async function handleChecklistAppendCommand(
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const tokens = tokenize(restArgs);
	if (tokens.length === 0) return usage("Usage: /checklist append [<phase>] <task...>", runtime);

	const current = currentPhases(runtime);
	const phaseName = tokens.length === 1 ? undefined : tokens[0];
	const content = tokens.length === 1 ? tokens[0]! : tokens.slice(1).join(" ");
	const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
	let targetPhase: ChecklistPhase;

	if (phaseName) {
		const existing = findPhaseFuzzy(next, phaseName);
		targetPhase = existing ?? { name: titleCaseWords(phaseName), tasks: [] };
		if (!existing) next.push(targetPhase);
	} else if (next.length > 0) {
		targetPhase = next[next.length - 1]!;
	} else {
		targetPhase = { name: "Checklist", tasks: [] };
		next.push(targetPhase);
	}

	const finalContent = titleCaseSentence(content);
	targetPhase.tasks.push({ content: finalContent, status: "pending" });
	commitChecklist(runtime, next);
	await runtime.output(`Appended to ${targetPhase.name}: ${finalContent}`);
	return commandConsumed();
}

async function handleChecklistStartCommand(
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!restArgs) return usage("Usage: /checklist start <task>", runtime);
	const current = currentPhases(runtime);
	const query = tokenize(restArgs).join(" ") || restArgs;
	const hit = findTaskFuzzy(current, query);
	if (!hit) return usage(`No task matched "${restArgs}". Use /checklist to list current tasks.`, runtime);
	const { phases } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
	commitChecklist(runtime, phases);
	await runtime.output(`Started: ${hit.task.content}`);
	return commandConsumed();
}

async function handleChecklistMutationCommand(
	verb: ChecklistMutationVerb,
	restArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const current = currentPhases(runtime);
	const trimmedArg = restArgs.trim();
	if (!trimmedArg) {
		if (verb === "rm") {
			commitChecklist(runtime, []);
			await runtime.output("Cleared all checklist items.");
			return commandConsumed();
		}
		const { phases } = applyOpsToPhases(current, [{ op: verb }]);
		commitChecklist(runtime, phases);
		await runtime.output(verb === "done" ? "Marked all tasks completed." : "Marked all tasks abandoned.");
		return commandConsumed();
	}

	const taskHit = findTaskFuzzy(current, trimmedArg);
	if (taskHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, task: taskHit.task.content }]);
		commitChecklist(runtime, phases);
		const label = verb === "done" ? "Marked completed" : verb === "drop" ? "Marked abandoned" : "Removed";
		await runtime.output(`${label}: ${taskHit.task.content}`);
		return commandConsumed();
	}

	const phaseHit = findPhaseFuzzy(current, trimmedArg);
	if (phaseHit) {
		const { phases } = applyOpsToPhases(current, [{ op: verb, phase: phaseHit.name }]);
		commitChecklist(runtime, phases);
		const message =
			verb === "done"
				? `Marked phase ${phaseHit.name} completed.`
				: verb === "drop"
					? `Marked phase ${phaseHit.name} abandoned.`
					: `Removed phase: ${phaseHit.name}`;
		await runtime.output(message);
		return commandConsumed();
	}

	return usage(`No task or phase matched "${trimmedArg}".`, runtime);
}

export async function handleChecklistAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const trimmed = command.args.trim();
	if (!trimmed) {
		const phases = currentPhases(runtime);
		await runtime.output(
			phases.length === 0
				? "No checklist items. Use /checklist append <task> to start one."
				: phasesToMarkdown(phases).trimEnd(),
		);
		return commandConsumed();
	}

	const { verb, rest } = parseSubcommand(trimmed);
	switch (verb) {
		case "copy":
			return await handleChecklistCopyCommand(runtime);
		case "export":
			return await handleChecklistExportCommand(rest, runtime);
		case "import":
			return await handleChecklistImportCommand(rest, runtime);
		case "append":
			return await handleChecklistAppendCommand(rest, runtime);
		case "start":
			return await handleChecklistStartCommand(rest, runtime);
		case "done":
		case "drop":
		case "rm":
			return await handleChecklistMutationCommand(verb, rest, runtime);
		case "edit":
			return usage(
				"/checklist edit requires the TUI editor; use /checklist export then /checklist import for non-interactive edits.",
				runtime,
			);
		case "help":
		case "?":
			await runtime.output(CHECKLIST_HELP_TEXT);
			return commandConsumed();
		default:
			return usage(
				"Unknown /checklist subcommand. Use append, start, done, drop, rm, copy, export, import.",
				runtime,
			);
	}
}
