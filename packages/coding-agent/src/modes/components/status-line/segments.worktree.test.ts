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

function renderFilesystemSegment(id: "path" | "git", cwd: string, repoRoot?: string, width = 40): string {
	return Bun.stripANSI(
		SEGMENTS[id].render({
			session: { sessionManager: { getCwd: () => cwd } },
			activeRepo: repoRoot === undefined ? null : { cwd, relativeRepoRoot: repoRoot },
			width: 120,
			options: { path: { stripWorkPrefix: false, abbreviate: false, maxLength: width } },
			compactThinkingLevel: false,
			prewalk: null,
			worktree: null,
			git: { branch: cwd, ahead: 0, behind: 0, dirty: false },
		} as never).content,
	);
}

test("ordinary paths and nested repo labels remain single-line and terminal-safe", () => {
	const content = renderFilesystemSegment("path", "/tmp/a\tb\rc\nd\x1b]0;evil\x07", "nested\troot\rrow\n2\x1b[31m");
	expect(content).toContain("/tmp/a b c d");
	expect(content).toContain(" ↳ nested root row 2");
	expect(content).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
});

test("path width is measured after tabs are flattened, including wide characters", () => {
	const content = renderFilesystemSegment("path", "/tmp/日本語\tproject", undefined, 10);
	expect(Bun.stringWidth(content)).toBeLessThanOrEqual(12); // Icon and its separator add two cells.
	expect(content).not.toContain("\t");
});

test("git labels use the same single-row sanitizer as paths and session titles", () => {
	const content = renderFilesystemSegment("git", "feature\tname\rnext\nrow\x1b[31m");
	expect(content).toContain("feature name next row");
	expect(content).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
});

test("custom model names are single-line and cannot inject terminal escapes", () => {
	const content = SEGMENTS.model.render({
		session: {
			state: { model: { name: "Custom\tModel\rNext\nRow\x1b]0;evil\x07" } },
			isAdvisorActive: () => false,
			isFastModeActive: () => false,
		},
		options: {},
	} as never).content;
	const plain = Bun.stripANSI(content);
	expect(plain).toContain("Custom Model Next Row");
	expect(plain).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
});
