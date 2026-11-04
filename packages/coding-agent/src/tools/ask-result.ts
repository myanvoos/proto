export interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;

	note?: string;
	noteOption?: string;

	timedOut?: boolean;
}

export interface AskToolDetails {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;

	note?: string;
	noteOption?: string;

	timedOut?: boolean;

	results?: QuestionResult[];

	chatRedirect?: boolean;

	questions?: string[];
}

export function formatQuestionResult(result: QuestionResult): string {
	if (result.timedOut) return `${result.id}: (no response before timeout)`;
	const noteOn = result.noteOption === undefined ? "" : ` on ${result.noteOption}`;
	const noteSuffix = result.note ? ` (note${noteOn}: ${result.note})` : "";
	const custom = result.customInput === undefined ? undefined : `"${result.customInput}"`;
	if (result.selectedOptions.length === 0) {
		if (custom !== undefined) return `${result.id}: ${custom}${noteSuffix}`;
		return result.multi ? `${result.id}: []${noteSuffix}` : `${result.id}: (cancelled)${noteSuffix}`;
	}
	const picked = result.multi ? `[${result.selectedOptions.join(", ")}]` : result.selectedOptions[0];
	const answer = custom === undefined ? picked : `${picked} + ${custom}`;
	return `${result.id}: ${answer}${noteSuffix}`;
}

export function formatSingleQuestionResponse(result: {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	noteOption?: string;
	timedOut?: boolean;
	multi: boolean;
}): string {
	if (result.timedOut) return "Ask timed out: no response received.";
	const responseParts: string[] = [];
	if (result.selectedOptions.length > 0) {
		const selectedText = result.multi
			? `User selected: ${result.selectedOptions.join(", ")}`
			: `User selected: ${result.selectedOptions[0]}`;
		responseParts.push(selectedText);
	}
	if (result.customInput !== undefined) {
		responseParts.push(
			result.customInput.includes("\n")
				? `User provided custom input:\n${result.customInput
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User provided custom input: ${result.customInput}`,
		);
	}
	if (result.note) {
		const label = `User added note${result.noteOption === undefined ? "" : ` on ${result.noteOption}`}:`;
		responseParts.push(
			result.note.includes("\n")
				? `${label}\n${result.note
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `${label} ${result.note}`,
		);
	}
	if (responseParts.length > 0) return responseParts.join("\n");
	return result.multi ? "User did not select any options" : "User cancelled the selection";
}
