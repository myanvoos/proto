import { expect, test, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import { BashExecutionComponent } from "./bash-execution";

initThemeSync();

function fakeUi(): TUI {
	return {
		requestComponentRender: () => {},
		requestRender: () => {},
		synchronizedOutput: false,
	} as unknown as TUI;
}

test("queued output is drained when the bash block finalizes without a result string", () => {
	const component = new BashExecutionComponent("printf burst", fakeUi());
	try {
		component.appendOutput("first");
		component.appendOutput("second");
		component.setComplete(undefined, false);

		expect(component.getOutput()).toBe("firstsecond");
	} finally {
		component.dispose();
	}
});

test("gated output is drained after the throttle window", () => {
	vi.useFakeTimers();
	const component = new BashExecutionComponent("printf burst", fakeUi());
	try {
		component.appendOutput("first");
		component.appendOutput("second");
		vi.advanceTimersByTime(50);

		expect(component.getOutput()).toBe("firstsecond");
	} finally {
		component.dispose();
		vi.useRealTimers();
	}
});
