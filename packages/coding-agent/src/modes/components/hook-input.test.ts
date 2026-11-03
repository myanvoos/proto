import { expect, test } from "bun:test";
import { initThemeSync } from "../theme/theme";
import { HookInputComponent } from "./hook-input";

initThemeSync();

test("secret input masks every painted character but submits the original value", () => {
	let submitted: string | undefined;
	const input = new HookInputComponent(
		"Token",
		undefined,
		value => {
			submitted = value;
		},
		() => {},
		{ secret: true },
	);
	input.pasteText("private-token");
	const painted = Bun.stripANSI(input.render(50).join("\n"));
	expect(painted).not.toContain("private-token");
	expect(painted).toContain("•");
	input.handleInput("\r");
	expect(submitted).toBe("private-token");
});
