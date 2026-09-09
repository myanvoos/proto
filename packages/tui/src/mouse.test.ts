import { expect, test } from "bun:test";
import { parseSgrMouse, routeSelectListMouse, type SelectListMouseTarget } from "./mouse";

test("SGR vertical and horizontal wheel reports retain distinct axes", () => {
	expect(parseSgrMouse("\x1b[<64;1;1M")?.wheel).toBe(-1);
	expect(parseSgrMouse("\x1b[<65;1;1M")?.wheel).toBe(1);

	for (const button of [66, 67]) {
		const event = parseSgrMouse(`\x1b[<${button};1;1M`);
		expect(event?.wheel).toBeNull();
		expect(event?.motion).toBe(false);
		expect(event?.leftClick).toBe(false);
	}
});

test("select lists ignore horizontal wheel reports instead of scrolling vertically", () => {
	let wheelCalls = 0;
	const target: SelectListMouseTarget = {
		handleWheel: () => {
			wheelCalls++;
		},
		hitTest: () => undefined,
		setHoverIndex: () => {},
		clickItem: () => {},
	};

	for (const button of [66, 67]) {
		const event = parseSgrMouse(`\x1b[<${button};1;1M`);
		expect(event).not.toBeNull();
		if (event) expect(routeSelectListMouse(target, event, 0)).toBe(false);
	}
	expect(wheelCalls).toBe(0);
});
