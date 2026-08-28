import { DOMWindow } from "./dom/core";
import { parseDocument } from "./dom/parser";

export {
	Attr,
	Comment,
	CSSStyleDeclaration,
	CustomEvent,
	DOMTokenList,
	DOMWindow,
	Document,
	DocumentFragment,
	Element,
	Event,
	EventTarget,
	HTMLElement,
	HTMLIFrameElement,
	HTMLMetaElement,
	HTMLTemplateElement,
	NamedNodeMap,
	Node,
	NodeType,
	SVGElement,
	serializeNode,
	Text,
} from "./dom/core";

export function parseHTML(html: string): DOMWindow {
	return new DOMWindow(parseDocument(html));
}
