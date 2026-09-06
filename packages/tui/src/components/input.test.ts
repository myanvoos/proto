import { expect, test } from "bun:test";
import { visibleWidth } from "../utils";
import { Input } from "./input";

test("replacing an input value prevents undo from restoring a previous prompt", () => {
	const input = new Input();
	input.setValue("previous response");
	input.handleInput(" edited");
	input.setValue("next response");
	input.handleInput("\x1f");
	expect(input.getValue()).toBe("next response");

	input.handleInput("!");
	input.handleInput("\x1f");
	expect(input.getValue()).toBe("next response");
});

test("replacing an input value ends typing and yank-pop sequences from the previous prompt", () => {
	const input = new Input();
	input.handleInput("old");
	input.setValue("new");
	input.handleInput("!");
	input.handleInput("\x1f");
	expect(input.getValue()).toBe("new");

	input.handleInput("\x15");
	input.handleInput("first");
	input.handleInput("\x15");
	input.handleInput("\x19");
	input.setValue("next response");
	input.handleInput("\x1by");
	expect(input.getValue()).toBe("next response");
});

test("narrow input viewports never emit an overflowing prompt or cursor", () => {
	const input = new Input();
	input.focused = true;
	input.prompt = "\x1b[36mSearch: \x1b[0m";
	input.setValue("\u4e2d\u6587 value");
	for (const width of [0, 1, 6, 7, 8, 10]) {
		for (const line of input.render(width)) {
			expect(visibleWidth(line), `input overflow at width ${width}`).toBeLessThanOrEqual(width);
		}
	}
});
