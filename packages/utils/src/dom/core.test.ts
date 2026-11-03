import { expect, test } from "bun:test";
import { parseHTML } from "../dom";
import TurndownService from "../turndown";

test("cached selectors and child indices follow node and attribute mutations", () => {
	const { document } = parseHTML('<main><p id="first">one</p><p class="selected">two</p></main>');
	const main = document.querySelector("main")!;
	const first = main.querySelector("#first")!;
	const second = main.querySelector(".selected")!;
	expect(main.querySelector("p:nth-child(2)")).toBe(second);
	main.removeChild(first);
	expect(main.querySelector("p:nth-child(1)")).toBe(second);
	const fragment = document.createDocumentFragment();
	fragment.append(first);
	main.insertBefore(fragment, second);
	expect(main.querySelector("p:nth-child(2)")).toBe(second);
	second.setAttribute("class", "changed");
	expect(main.querySelector(".selected")).toBeNull();
	expect(main.querySelector(".changed")).toBe(second);
});

test("HTML conversion skips ignored custom-rule children without losing sibling output", () => {
	const service = new TurndownService();
	service.addRule("opaque", { filter: "section", skipContent: true, replacement: () => "[section]" });
	expect(service.turndown("<section><strong>hidden</strong></section><p>visible</p>")).toBe("[section]\n\nvisible");
});
