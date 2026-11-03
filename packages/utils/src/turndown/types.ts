export interface TurndownNode {
	readonly nodeType: number;
	readonly nodeName: string;
	readonly parentNode: TurndownNode | null;
	readonly childNodes: ArrayLike<TurndownNode>;
	readonly children: ArrayLike<TurndownNode>;
	readonly firstChild: TurndownNode | null;
	readonly lastChild: TurndownNode | null;
	readonly nextSibling: TurndownNode | null;
	readonly previousSibling: TurndownNode | null;
	readonly textContent: string | null;
	readonly outerHTML?: string;
	/** Position among the parent's element children, when the node implementation tracks it. */
	readonly elementIndex?: number;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
}

export interface TurndownOptions {
	headingStyle?: "setext" | "atx";
	hr?: string;
	bulletListMarker?: "*" | "-" | "+";
	codeBlockStyle?: "indented" | "fenced";
	fence?: string;
	emDelimiter?: "_" | "*";
	strongDelimiter?: "**" | "__";
	linkStyle?: "inlined" | "referenced";
	linkReferenceStyle?: "full" | "collapsed" | "shortcut";
	preformattedCode?: boolean;
	blankReplacement?: ReplacementFunction;
	keepReplacement?: ReplacementFunction;
	defaultReplacement?: ReplacementFunction;
}

export interface ResolvedTurndownOptions {
	headingStyle: "setext" | "atx";
	hr: string;
	bulletListMarker: "*" | "-" | "+";
	codeBlockStyle: "indented" | "fenced";
	fence: string;
	emDelimiter: "_" | "*";
	strongDelimiter: "**" | "__";
	linkStyle: "inlined" | "referenced";
	linkReferenceStyle: "full" | "collapsed" | "shortcut";
	preformattedCode: boolean;
	blankReplacement?: ReplacementFunction;
	keepReplacement?: ReplacementFunction;
	defaultReplacement?: ReplacementFunction;
}

export type RuleFilter =
	| string
	| readonly string[]
	| ((node: TurndownNode, options: ResolvedTurndownOptions) => boolean);

export type ReplacementFunction = (content: string, node: TurndownNode, options: ResolvedTurndownOptions) => string;

export interface TurndownRule {
	filter: RuleFilter;
	replacement: ReplacementFunction;
	/**
	 * Set when `replacement` ignores its `content` argument; the service then skips
	 * converting the node's children before calling it.
	 */
	skipContent?: boolean;
}

export type TurndownPlugin = (service: TurndownServiceLike) => void;

export interface TurndownServiceLike {
	readonly options: ResolvedTurndownOptions;
	addRule(key: string, rule: TurndownRule): this;
	convertChildren(node: TurndownNode): string;
	keep(filter: RuleFilter): this;
	remove(filter: RuleFilter): this;
	turndown(input: string | TurndownNode): string;
	escape(text: string): string;
}
