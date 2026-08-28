import type { AutocompleteItem } from "@oh-my-pi/pi-tui";

const GITHUB_REF_KINDS = [
	{ qualifier: "pr", scheme: "pr", label: "PR", description: "GitHub pull request" },
	{ qualifier: "issue", scheme: "issue", label: "Issue", description: "GitHub issue" },
] as const;

interface GithubRefContext {
	prefix: string;

	qualifier: "pr" | "issue" | null;

	number: string;
}

const GITHUB_REF_TOKEN_RE = /(?:^|[\s"'`(<=])(?:(pr|pull|issue)(\s+))?#([1-9]\d*)$/i;

export function getGithubRefContext(textBeforeCursor: string): GithubRefContext | null {
	const match = textBeforeCursor.match(GITHUB_REF_TOKEN_RE);
	if (!match) return null;
	const qualifierWord = match[1];
	const whitespace = match[2] ?? "";
	const number = match[3] ?? "";
	return {
		prefix: qualifierWord ? `${qualifierWord}${whitespace}#${number}` : `#${number}`,
		qualifier: !qualifierWord ? null : qualifierWord.toLowerCase() === "issue" ? "issue" : "pr",
		number,
	};
}

export function getGithubRefSuggestions(
	textBeforeCursor: string,
): { items: AutocompleteItem[]; prefix: string } | null {
	const context = getGithubRefContext(textBeforeCursor);
	if (!context) return null;
	const kinds = context.qualifier
		? GITHUB_REF_KINDS.filter(kind => kind.qualifier === context.qualifier)
		: GITHUB_REF_KINDS;
	const items: AutocompleteItem[] = kinds.map(kind => ({
		value: `${kind.scheme}://${context.number}`,
		label: `${kind.label} #${context.number}`,
		description: kind.description,
	}));
	return { items, prefix: context.prefix };
}
