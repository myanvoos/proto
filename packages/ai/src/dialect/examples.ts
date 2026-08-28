import { pyCall } from "./rendering";
import type { InbandTool } from "./types";

const INTENT_PLACEHOLDER = "…";

export function renderToolExamples(tool: InbandTool, intentField?: string): string {
	const examples = tool.examples;
	if (!examples?.length) return "";
	const renderCall = (args: Record<string, unknown>): string => {
		const bare = bareStringArg(args);
		if (bare !== undefined) {
			const intentAttr = intentField ? ` ${intentField}="${INTENT_PLACEHOLDER}"` : "";
			return `<example${intentAttr}>\n${bare}\n</example>`;
		}

		const finalArgs = intentField ? { [intentField]: INTENT_PLACEHOLDER, ...args } : args;
		return `<example>\n${pyCall(tool.name, finalArgs)}\n</example>`;
	};
	const parts = examples.map(ex => {
		const head = ex.caption ? `# ${ex.caption}\n` : "";
		if ("call" in ex) return head + renderCall(ex.call);
		if ("good" in ex) {
			return `${head}WRONG:\n${renderCall(ex.bad)}\nRIGHT:\n${renderCall(ex.good)}`;
		}
		return head.trimEnd() + (ex.note ? `\n${ex.note}` : "");
	});
	return `<examples>\n${parts.join("\n")}\n</examples>`;
}

export function renderToolExamplesJsdoc(tool: InbandTool): string {
	const examples = tool.examples;
	if (!examples?.length) return "";
	const renderCall = (args: Record<string, unknown>): string => bareStringArg(args) ?? pyCall(tool.name, args);
	const parts = examples.map(ex => {
		const head = ex.caption ? `@example ${JSON.stringify(ex.caption)}` : "@example";
		if ("call" in ex) return `${head}\n${renderCall(ex.call)}`;
		if ("good" in ex) return `${head}\nWRONG:\n${renderCall(ex.bad)}\nRIGHT:\n${renderCall(ex.good)}`;
		return ex.note ? `${head}\n${ex.note}` : head;
	});
	return parts.join("\n");
}

function bareStringArg(args: Record<string, unknown>): string | undefined {
	let sole: unknown;
	let count = 0;
	for (const key in args) {
		count++;
		sole = args[key];
	}
	return count === 1 && typeof sole === "string" ? sole : undefined;
}
