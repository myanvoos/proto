import { expect, test, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initThemeSync } from "../theme/theme";
import { BashExecutionComponent } from "./bash-execution";
import { EvalExecutionComponent } from "./eval-execution";

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

for (const Component of [BashExecutionComponent, EvalExecutionComponent]) {
	test(`${Component.name} prints no timing or diagnostics on a clean completion`, () => {
		const component = new Component("echo hello", fakeUi());
		try {
			component.setComplete(0, false, {
				output: "hello",
				execution: {
					state: "exited",
					exitCode: 0,
					elapsedMs: 83,
					collector: { state: "complete" },
					renderer: { state: "complete" },
					output: { disposition: "complete" },
				},
			});
			const text = component
				.render(80)
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(text).toContain("hello");
			expect(text).not.toMatch(/Execution:|collector=|renderer=|output=|83ms|exit 0/);
		} finally {
			component.dispose();
		}
	});

	test(`${Component.name} shows the plain running loader and outcome markers only after completion`, () => {
		vi.useFakeTimers();
		const component = new Component("sleep 5", fakeUi());
		const render = () =>
			component
				.render(80)
				.map(row => Bun.stripANSI(row))
				.join("\n");
		try {
			expect(render()).toContain("Running… (esc to cancel)");
			component.setComplete(2, false, {});
			expect(render()).toContain("(exit 2)");
			// Soft exit 1 stays a dim data point, not a failure.
			component.setComplete(1, false, {
				execution: {
					state: "exited",
					exitCode: 1,
					softExit: true,
					collector: { state: "complete" },
					renderer: { state: "complete" },
					output: { disposition: "complete" },
				},
			});
			const soft = render();
			expect(soft).toContain("(exit 1)");
			expect(soft).not.toContain("Running…");
		} finally {
			component.dispose();
			vi.useRealTimers();
		}
	});
}
