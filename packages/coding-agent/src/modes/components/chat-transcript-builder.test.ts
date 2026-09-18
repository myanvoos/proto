import { expect, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { SessionMessageEntry } from "../../session/session-entries";
import { initTheme } from "../theme/theme";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";

await Settings.init();
await initTheme(false, false, "proto");

test("synthetic developer context the model acted on is invisible in the focused transcript", () => {
	const builder = new ChatTranscriptBuilder({
		ui: { requestRender: () => {} } as unknown as TUI,
		requestRender: () => {},
	});
	const entries = [
		{
			message: {
				role: "developer",
				content: "Synthetic developer context\tthe model acted on is visible when expanded.",
				timestamp: 1,
			},
		},
	] as unknown as SessionMessageEntry[];

	try {
		builder.rebuild(entries);
		builder.setExpanded(true);
		const rendered = Bun.stripANSI(builder.container.render(160).join("\n"));
		expect(rendered).toContain("Synthetic developer context");
		expect(rendered).toContain("the model acted on is visible when expanded.");
		expect(rendered).not.toContain("\t");
	} finally {
		builder.dispose();
	}
});
