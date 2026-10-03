import { describe, expect, test } from "bun:test";
import { type ChangelogEntry, formatStartupChangelogSummary, selectStartupChangelog } from "./changelog";

function summarize(content: string) {
	const entries: ChangelogEntry[] = [{ major: 1, minor: 1, patch: 0, content: `## [1.1.0] - 2026-01-01\n${content}` }];
	return selectStartupChangelog(entries, "1.0.0", "1.1.0");
}

describe("startup changelog summary", () => {
	test("counts a bullet written above any category heading", () => {
		const selection = summarize(`
- Fixed a thing before any heading.

### Changed

- Changed a thing.
`);
		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Other: 1, Changed: 1 });
	});

	test("counts every CommonMark bullet marker and indented top-level lists", () => {
		const selection = summarize(`
### Added

- Added a dash entry.
+ Added a plus entry.
* Added a star entry.

### Changed

   - Changed a thing.
   - Changed another thing.
`);
		expect(selection.changeCount).toBe(5);
		expect(selection.categoryCounts).toEqual({ Added: 3, Changed: 2 });
	});

	test("does not count nested details, code blocks, empty markers, or thematic breaks", () => {
		const selection = summarize(`
### Fixed

- Fixed a thing with details:
  - detail one
  - detail two

* * *

\t- Renders as an indented code block, not a change.
- Fixed a second thing.

 - detail kept inside the item above
-
`);
		expect(selection.changeCount).toBe(2);
		expect(selection.categoryCounts).toEqual({ Fixed: 2 });
	});

	test("announced change count equals the sum of the rendered breakdown", () => {
		const selection = summarize(`
- Uncategorized fix.

### Breaking Changes

- Removed a flag.

### Fixed

- Ordinary fix.
  - nested detail
+ Plus-marker fix.
`);
		const breakdown = Object.values(selection.categoryCounts).reduce((total, count) => total + count, 0);
		expect(selection.changeCount).toBe(breakdown);
		expect(formatStartupChangelogSummary(selection)).toContain("4 changes");
	});
});
