export interface ReadabilityNode {
	readonly nodeType: number;
	readonly nodeName: string;
	readonly tagName?: string;
	readonly ownerDocument?: ReadabilityDocument | null;
	parentNode: ReadabilityNode | null;
	readonly children?: ArrayLike<ReadabilityElement>;
	readonly childNodes: ArrayLike<ReadabilityNode>;
	readonly firstChild: ReadabilityNode | null;
	readonly textContent: string | null;
	appendChild(node: ReadabilityNode): ReadabilityNode;
	cloneNode(deep?: boolean): ReadabilityNode;
	remove(): void;
}

export interface ReadabilityElement extends ReadabilityNode {
	readonly children: ArrayLike<ReadabilityElement>;
	readonly tagName: string;
	id: string;
	className: string;
	innerHTML: string;
	readonly attributes: ArrayLike<{ readonly name: string; readonly value: string }>;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	getElementsByTagName(name: string): ArrayLike<ReadabilityElement>;
	querySelector(selector: string): ReadabilityElement | null;
	querySelectorAll(selector: string): ArrayLike<ReadabilityElement>;
}

export interface ReadabilityDocument extends ReadabilityNode {
	title: string;
	readonly body: ReadabilityElement | null;
	readonly documentElement: ReadabilityElement | null;
	createElement(name: string): ReadabilityElement;
	getElementsByTagName(name: string): ArrayLike<ReadabilityElement>;
	querySelector(selector: string): ReadabilityElement | null;
	querySelectorAll(selector: string): ArrayLike<ReadabilityElement>;
}

export interface ReadabilityOptions<T = string> {
	debug?: boolean;
	maxElemsToParse?: number;
	nbTopCandidates?: number;
	charThreshold?: number;
	classesToPreserve?: string[];
	keepClasses?: boolean;
	serializer?: (node: ReadabilityNode) => T;
	disableJSONLD?: boolean;
	allowedVideoRegex?: RegExp;
}

export interface ReadabilityArticle<T = string> {
	title: string | null | undefined;
	content: T | null | undefined;
	textContent: string | null | undefined;
	length: number | null | undefined;
	excerpt: string | null | undefined;
	byline: string | null | undefined;
	dir: string | null | undefined;
	siteName: string | null | undefined;
	lang: string | null | undefined;
	publishedTime: string | null | undefined;
}
