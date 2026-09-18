import { expect, test } from "bun:test";
import { ScrollView } from "./scroll-view";

test("terminal resize moves the user's place in the transcript", () => {
	const view = new ScrollView(["history-wide", "ANCHOR", "NEXT"], { height: 2, scrollbar: "never" });
	view.setScrollOffset(1);
	expect(view.render(40)).toEqual(["ANCHOR", "NEXT"]);

	view.setLines(["history", "wide", "wrap", "ANCHOR", "NEXT"]);

	expect(view.getScrollOffset()).toBe(3);
	expect(view.render(10)).toEqual(["ANCHOR", "NEXT"]);
});

test("shrinking content past the current offset renders a blank viewport", () => {
	const view = new ScrollView(["zero", "one", "two", "three"], { height: 2, scrollbar: "never" });
	view.scrollToBottom();

	view.setLines(["remaining"]);

	expect(view.getScrollOffset()).toBe(0);
	expect(view.render(20)).toEqual(["remaining", ""]);
});

test("windowed totalRows mode renders the supplied slice independently of the scrollbar offset", () => {
	const view = new ScrollView(["window-row-7", "window-row-8"], {
		height: 2,
		scrollbar: "never",
		totalRows: 10,
	});
	view.setScrollOffset(7);
	view.setLines(["replacement-7", "replacement-8"]);

	expect(view.getScrollOffset()).toBe(7);
	expect(view.render(40)).toEqual(["replacement-7", "replacement-8"]);
});
