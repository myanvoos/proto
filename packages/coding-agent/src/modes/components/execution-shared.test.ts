import { expect, test } from "bun:test";
import type { Text } from "@oh-my-pi/pi-tui/components/text";
import type { ExecutionMetadata } from "../../session/execution-metadata";
import { initThemeSync, theme } from "../theme/theme";
import { buildStatusFooter, resolveExecutionStatus } from "./execution-shared";

initThemeSync();

function metadata(overrides: Partial<ExecutionMetadata> = {}): ExecutionMetadata {
	return {
		state: "exited",
		collector: { state: "complete" },
		renderer: { state: "complete" },
		output: { disposition: "complete" },
		...overrides,
	};
}

function renderFooter(footer: Text | undefined): string {
	return Bun.stripANSI(footer?.render(120).join("\n") ?? "")
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean)
		.join("\n");
}

test("shell exit 1 completes when marked soft (rg no-match must not render as failure)", () => {
	expect(resolveExecutionStatus(0, false)).toBe("complete");
	expect(resolveExecutionStatus(1, false, metadata({ softExit: true }))).toBe("complete");
	expect(resolveExecutionStatus(undefined, false)).toBe("complete");
});

test("unmarked exit 1 fails — kernel cells exit 1 on any raised exception", () => {
	expect(resolveExecutionStatus(1, false)).toBe("error");
});

test("hard exit codes fail: tool errors, exec failures, signal deaths", () => {
	expect(resolveExecutionStatus(2, false)).toBe("error");
	expect(resolveExecutionStatus(127, false)).toBe("error");
	expect(resolveExecutionStatus(143, false)).toBe("error");
	expect(resolveExecutionStatus(-1, false)).toBe("error");
});

test("observed signal or fired timeout fails the command even with a clean exit code", () => {
	expect(resolveExecutionStatus(0, false, metadata({ signal: "SIGKILL" }))).toBe("error");
	expect(resolveExecutionStatus(0, false, metadata({ timeout: { cause: "deadline", scope: "command" } }))).toBe(
		"error",
	);
});

test("signal or timeout overrides the soft-exit marker", () => {
	expect(resolveExecutionStatus(1, false, metadata({ softExit: true, signal: "SIGTERM" }))).toBe("error");
	expect(
		resolveExecutionStatus(1, false, metadata({ softExit: true, timeout: { cause: "deadline", scope: "command" } })),
	).toBe("error");
});

test("cancellation outranks exit classification", () => {
	expect(resolveExecutionStatus(143, true, metadata({ signal: "SIGTERM" }))).toBe("cancelled");
});

test("unknown and running execution states pass through", () => {
	expect(resolveExecutionStatus(undefined, false, metadata({ state: "unknown" }))).toBe("unknown");
	expect(resolveExecutionStatus(undefined, false, metadata({ state: "running" }))).toBe("running");
});

test("buildStatusFooter keeps outcome markers and never prints execution diagnostics", () => {
	const cancelled = buildStatusFooter({
		status: "cancelled",
		exitCode: 143,
		truncation: undefined,
		hiddenLineCount: 0,
	});
	expect(renderFooter(cancelled)).toBe("(cancelled)");

	const hard = buildStatusFooter({ status: "error", exitCode: 2, truncation: undefined, hiddenLineCount: 0 });
	expect(renderFooter(hard)).toContain("(exit 2)");

	// Soft non-zero exit stays visible for reference without failure styling.
	const soft = buildStatusFooter({ status: "complete", exitCode: 1, truncation: undefined, hiddenLineCount: 0 });
	expect(renderFooter(soft)).toContain("(exit 1)");
	expect(soft?.render(120).join("\n")).toContain(theme.fg("dim", "(exit 1)"));
	expect(soft?.render(120).join("\n")).not.toContain(theme.fg("error", "(exit 1)"));

	// A clean exit renders no outcome line at all — no timing, no diagnostics.
	const clean = buildStatusFooter({ status: "complete", exitCode: 0, truncation: undefined, hiddenLineCount: 0 });
	expect(clean).toBeUndefined();

	const hidden = buildStatusFooter({ status: "error", exitCode: 2, truncation: undefined, hiddenLineCount: 2 });
	expect(renderFooter(hidden)).toContain("… 2 earlier lines");
});
