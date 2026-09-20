import { expect, test } from "bun:test";
import type { ExecutionMetadata } from "../../session/execution-metadata";
import { initThemeSync } from "../theme/theme";
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

function footerText(opts: Parameters<typeof buildStatusFooter>[0]): string {
	const footer = buildStatusFooter(opts);
	return footer
		? footer
				.render(80)
				.map(row => Bun.stripANSI(row))
				.join("\n")
		: "";
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

test("soft non-zero exit shows a dim exit marker; clean success shows none", () => {
	expect(footerText({ status: "complete", exitCode: 1, truncation: undefined, hiddenLineCount: 0 })).toContain(
		"(exit 1)",
	);
	expect(
		buildStatusFooter({ status: "complete", exitCode: 0, truncation: undefined, hiddenLineCount: 0 }),
	).toBeUndefined();
});

test("hard failures keep the failure-styled exit marker", () => {
	expect(footerText({ status: "error", exitCode: 2, truncation: undefined, hiddenLineCount: 0 })).toContain(
		"(exit 2)",
	);
});
