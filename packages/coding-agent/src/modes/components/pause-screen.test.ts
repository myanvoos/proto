import { expect, test } from "bun:test";
import { initThemeSync } from "../theme/theme";
import { renderPauseScreen } from "./pause-screen";

initThemeSync();

test("a one-row pause overlay keeps its resume control before elapsed time and session title", () => {
	const rows = renderPauseScreen(12, 1, 90_000, "a session title that cannot fit");
	expect(rows).toHaveLength(1);
	expect(Bun.stripANSI(rows[0]!)).toContain("esc resume");
	expect(Bun.stringWidth(rows[0]!)).toBeLessThanOrEqual(12);
});
