import { expect, test } from "bun:test";
import { initThemeSync } from "../../theme/theme";
import { SEGMENTS } from "./segments";

initThemeSync();

function renderPathSegment(worktree: { projectName: string; worktreeName: string }, branch: string): string {
	const segment = SEGMENTS.path;
	const rendered = segment.render({
		session: {} as never,
		activeRepo: null,
		width: 120,
		options: {},
		compactThinkingLevel: false,
		prewalk: null,
		worktree,
		git: { branch, ahead: 0, behind: 0, dirty: false },
	} as never);
	return rendered.content;
}

test("worktree path label strips control bytes from filesystem-derived basenames", () => {
	const hostile = {
		projectName: "proj\x1b]0;evil\x07ect\nrow2",
		worktreeName: "wt\x1b[31mred",
	};
	const content = renderPathSegment(hostile, "wt\x1b[31mred");
	// Theme styling legitimately emits SGR sequences; the hostile payload must
	// be gone and the label must stay one line.
	const labelOnly = content.replace(/\x1b\[[0-9;]*m/g, "");
	expect(labelOnly).not.toContain("\x1b");
	expect(labelOnly).not.toContain("\n");
	expect(labelOnly).toBe("◫ project row2/wtred");
});

test("a worktree label that sanitizes away entirely renders no content", () => {
	const content = renderPathSegment({ projectName: "\x1b[31m", worktreeName: "\x1b[0m" }, "\x1b[31m");
	// Icon + label is still a single line; the label itself carries no escapes.
	expect(content).not.toContain("\x1b");
	expect(content).not.toContain("\n");
});
