import { expect, test } from "bun:test";
import { Settings, settings } from "../../config/settings";
import { initThemeSync, theme } from "../theme/theme";
import { createAdvisorMessageCard } from "./advisor-message";

initThemeSync();

test("advisor row caps keep the header and expansion recovers the hidden note", async () => {
	await Settings.init({ inMemory: true });
	const before = settings.get("display.advisorCollapsedLines");
	settings.override("display.advisorCollapsedLines", 2);
	let expanded = false;
	try {
		const card = createAdvisorMessageCard(
			{ notes: [{ note: `${"long note ".repeat(40)}END_MARKER`, severity: "concern" }] },
			() => expanded,
			theme,
		);
		const collapsed = card.render(45);
		expect(collapsed).toHaveLength(3);
		expect(Bun.stripANSI(collapsed[0]!)).toContain("Advisor");
		expect(Bun.stripANSI(collapsed.join("\n"))).not.toContain("END_MARKER");
		expanded = true;
		expect(Bun.stripANSI(card.render(45).join("\n"))).toContain("END_MARKER");
	} finally {
		settings.override("display.advisorCollapsedLines", before);
	}
});
