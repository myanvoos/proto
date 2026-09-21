import * as fs from "node:fs/promises";
import {
	applyOpsToPhases,
	type ChecklistItem,
	type ChecklistPhase,
	getLatestChecklistPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveChecklistMarkdownPath,
	USER_CHECKLIST_EDIT_CUSTOM_TYPE,
} from "../../tools/checklist";
import { copyToClipboard } from "../../utils/clipboard";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import type { InteractiveModeContext } from "../types";

const USAGE = [
	"Usage: /checklist <verb> [args]",
	"  /checklist                              Show current checklist items",
	"  /checklist edit                         Open checklist items in $EDITOR",
	"  /checklist copy                         Copy checklist items as Markdown to clipboard",
	"  /checklist export [<path>]              Write checklist items to file (default: CHECKLIST.md)",
	"  /checklist import [<path>]              Replace checklist items from file (default: CHECKLIST.md)",
	"  /checklist append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
	"  /checklist start  <task>                Mark task in_progress (fuzzy content match)",
	"  /checklist done   [<task|phase>]        Mark task/phase/all completed",
	"  /checklist drop   [<task|phase>]        Mark task/phase/all abandoned",
	"  /checklist rm     [<task|phase>]        Remove task/phase/all",
].join("\n");

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			cur += input[++i];
			continue;
		}
		if (ch === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (cur) {
				tokens.push(cur);
				cur = "";
			}
			continue;
		}
		cur += ch;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

function titleCase(s: string): string {
	return s
		.split(/\s+/)
		.filter(Boolean)
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

function findPhaseFuzzy(phases: ChecklistPhase[], query: string): ChecklistPhase | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;

	const byName = phases.find(p => p.name.toLowerCase() === q);
	if (byName) return byName;

	const prefixMatches = phases.filter(p => p.name.toLowerCase().startsWith(q));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const subMatches = phases.filter(p => p.name.toLowerCase().includes(q));
	if (subMatches.length === 1) return subMatches[0];
	return undefined;
}

function findTaskFuzzy(
	phases: ChecklistPhase[],
	query: string,
): { task: ChecklistItem; phase: ChecklistPhase } | undefined {
	const q = query.trim().toLowerCase();
	if (!q) return undefined;

	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === q) return { task, phase };
		}
	}
	const matches: Array<{ task: ChecklistItem; phase: ChecklistPhase }> = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(q)) {
				matches.push({ task, phase });
			}
		}
	}
	if (matches.length === 1) return matches[0];

	const active = matches.filter(m => m.task.status === "in_progress" || m.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

function buildSystemReminder(action: string, phases: ChecklistPhase[], removed = false): string {
	const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	const lines = ["<system-reminder>", `The user manually modified the checklist list (${action}).`];
	if (removed) {
		lines.push(
			phases.length === 0
				? "The user intentionally cleared the checklist list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a checklist list."
				: "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
		);
	}
	lines.push("Current checklist list:", "", md, "</system-reminder>");
	return lines.join("\n");
}

export class ChecklistCommandController {
	constructor(private readonly ctx: InteractiveModeContext) {}

	#currentPhases(): ChecklistPhase[] {
		const fromEntries = getLatestChecklistPhasesFromEntries(this.ctx.sessionManager.getBranch());
		if (fromEntries.length > 0) return fromEntries;
		return this.ctx.session.getChecklistPhases();
	}

	async handleChecklistCommand(args: string): Promise<void> {
		const trimmed = args.trim();
		if (!trimmed) {
			this.#showCurrent();
			return;
		}

		const spaceIdx = trimmed.search(/\s/);
		const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
		const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

		switch (verb) {
			case "edit":
				await this.#editInExternalEditor();
				return;
			case "copy":
				this.#copyMarkdown();
				return;
			case "export":
				await this.#exportToFile(rest);
				return;
			case "import":
				await this.#importFromFile(rest);
				return;
			case "help":
			case "?":
				this.ctx.showStatus(USAGE);
				return;
			case "append":
				this.#append(rest);
				return;
			case "start":
				this.#start(rest);
				return;
			case "done":
				this.#mutateStatus(rest, "completed");
				return;
			case "drop":
				this.#mutateStatus(rest, "abandoned");
				return;
			case "rm":
				this.#remove(rest);
				return;
			default:
				this.ctx.showError(`Unknown /checklist verb "${verb}".\n${USAGE}`);
		}
	}

	#showCurrent(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showStatus("No checklist items. Use /checklist append <task> to start one.");
			return;
		}
		this.ctx.showStatus(phasesToMarkdown(phases).trimEnd());
	}

	#copyMarkdown(): void {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No checklist items to copy.");
			return;
		}
		try {
			copyToClipboard(phasesToMarkdown(phases));
			this.ctx.showStatus("Copied checklist items as Markdown to clipboard.");
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	#resolveChecklistPath(rest: string): string {
		return resolveChecklistMarkdownPath(rest, this.ctx.sessionManager.getCwd());
	}

	async #exportToFile(rest: string): Promise<void> {
		const phases = this.#currentPhases();
		if (phases.length === 0) {
			this.ctx.showWarning("No checklist items to export.");
			return;
		}
		try {
			const target = this.#resolveChecklistPath(rest);
			await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
			this.ctx.showStatus(`Wrote checklist items to ${target}`);
		} catch (error) {
			this.ctx.showError(`Failed to write items: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #importFromFile(rest: string): Promise<void> {
		let source = "";
		let content: string;
		try {
			source = this.#resolveChecklistPath(rest);
			content = await fs.readFile(source, "utf8");
		} catch (error) {
			this.ctx.showError(`Failed to read items: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const { phases, errors } = markdownToPhases(content);
		if (errors.length > 0) {
			this.ctx.showError(`Could not parse ${source}:\n  ${errors.join("\n  ")}`);
			return;
		}
		this.#commit(phases, `/checklist import ${source}`);
		const taskCount = phases.reduce((sum, p) => sum + p.tasks.length, 0);
		this.ctx.showStatus(`Imported ${phases.length} phase(s), ${taskCount} task(s) from ${source}.`);
	}

	#append(rest: string): void {
		const tokens = tokenize(rest);
		if (tokens.length === 0) {
			this.ctx.showError("Usage: /checklist append [<phase>] <task...>");
			return;
		}

		const current = this.#currentPhases();
		let phaseName: string | undefined;
		let content: string;

		if (tokens.length === 1) {
			content = tokens[0];
		} else {
			phaseName = tokens[0];
			content = tokens.slice(1).join(" ");
		}

		const next = current.map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
		let targetPhase: ChecklistPhase | undefined;

		if (phaseName) {
			targetPhase = findPhaseFuzzy(next, phaseName);
			if (!targetPhase) {
				targetPhase = { name: titleCase(phaseName), tasks: [] };
				next.push(targetPhase);
			}
		} else if (next.length > 0) {
			targetPhase = next[next.length - 1];
		} else {
			targetPhase = { name: "Checklist", tasks: [] };
			next.push(targetPhase);
		}

		const finalContent = titleCaseSentence(content);
		targetPhase.tasks.push({
			content: finalContent,
			status: "pending",
		});

		this.#commit(next, `/checklist append → ${targetPhase.name}`);
		this.ctx.showStatus(`Appended to ${targetPhase.name}: ${finalContent}`);
	}

	#start(rest: string): void {
		if (!rest) {
			this.ctx.showError("Usage: /checklist start <task>");
			return;
		}
		const current = this.#currentPhases();
		const hit = findTaskFuzzy(current, rest);
		if (!hit) {
			this.ctx.showError(`No task matched "${rest}". Use /checklist to list current tasks.`);
			return;
		}
		const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
		if (errors.length > 0) {
			this.ctx.showError(errors.join("; "));
			return;
		}
		this.#commit(phases, `/checklist start ${hit.task.content}`);
		this.ctx.showStatus(`Started: ${hit.task.content}`);
	}

	#mutateStatus(rest: string, target: "completed" | "abandoned"): void {
		const op = target === "completed" ? "done" : "drop";
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			const { phases, errors } = applyOpsToPhases(current, [{ op }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/checklist ${op} (all)`);
			this.ctx.showStatus(`Marked all tasks ${target}.`);
			return;
		}

		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, task: taskHit.task.content }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/checklist ${op} ${taskHit.task.content}`);
			this.ctx.showStatus(`Marked ${target}: ${taskHit.task.content}`);
			return;
		}

		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op, phase: phaseHit.name }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/checklist ${op} ${phaseHit.name}`);
			this.ctx.showStatus(`Marked phase ${phaseHit.name} ${target}.`);
			return;
		}

		this.ctx.showError(`No task or phase matched "${trimmed}".`);
	}

	#remove(rest: string): void {
		const current = this.#currentPhases();
		const trimmed = rest.trim();
		if (!trimmed) {
			this.#commit([], "/checklist rm (all)", { removed: true });
			this.ctx.showStatus("Cleared all checklist items.");
			return;
		}
		const taskHit = findTaskFuzzy(current, trimmed);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", task: taskHit.task.content }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/checklist rm ${taskHit.task.content}`, { removed: true });
			this.ctx.showStatus(`Removed: ${taskHit.task.content}`);
			return;
		}
		const phaseHit = findPhaseFuzzy(current, trimmed);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: "rm", phase: phaseHit.name }]);
			if (errors.length > 0) {
				this.ctx.showError(errors.join("; "));
				return;
			}
			this.#commit(phases, `/checklist rm ${phaseHit.name}`, { removed: true });
			this.ctx.showStatus(`Removed phase: ${phaseHit.name}`);
			return;
		}
		this.ctx.showError(`No task or phase matched "${trimmed}".`);
	}

	async #editInExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const current = this.#currentPhases();
		const initialMarkdown =
			current.length > 0 ? phasesToMarkdown(current) : "# Checklist\n- [ ] (replace this with your tasks)\n";

		this.ctx.ui.stop();
		try {
			const result = await openInEditor(editorCmd, initialMarkdown, { extension: ".checklist.md" });
			if (result === null) {
				this.ctx.showWarning("Editor exited without saving; checklist items unchanged.");
				return;
			}
			const { phases: parsed, errors } = markdownToPhases(result);
			if (errors.length > 0) {
				this.ctx.showError(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
				return;
			}
			this.#commit(parsed, "/checklist edit");
			const taskCount = parsed.reduce((sum, p) => sum + p.tasks.length, 0);
			this.ctx.showStatus(`Checklist updated from editor: ${parsed.length} phase(s), ${taskCount} task(s).`);
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	#commit(nextPhases: ChecklistPhase[], action: string, opts?: { removed?: boolean }): void {
		this.ctx.session.setChecklistPhases(nextPhases);
		this.ctx.setChecklist(nextPhases);

		this.ctx.sessionManager.appendCustomEntry(USER_CHECKLIST_EDIT_CUSTOM_TYPE, { phases: nextPhases });

		const reminderText = buildSystemReminder(action, nextPhases, opts?.removed ?? false);
		const message = {
			role: "developer" as const,
			content: [{ type: "text" as const, text: reminderText }],
			attribution: "user" as const,
			timestamp: Date.now(),
		};
		this.ctx.agent.appendMessage(message);
		this.ctx.sessionManager.appendMessage(message);
	}
}

function titleCaseSentence(s: string): string {
	const trimmed = s.trim();
	if (!trimmed) return trimmed;
	return trimmed[0].toUpperCase() + trimmed.slice(1);
}
