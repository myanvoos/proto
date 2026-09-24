import { expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { UiHelpers } from "./ui-helpers";

await initTheme(false, false, "proto");

// One unique frame per render pass, mirroring the composer: the live render
// cache is keyed by frame, so each pass must observe fresh mutations.
let pass = 0;
const frame = () => ({ now: pass * 1e6, tick: pass++ });

test("a status after one already committed to scrollback reaches the screen instead of rewriting the frozen row", () => {
	const chat = new TranscriptContainer();
	const ctx = {
		chatContainer: chat,
		ui: { requestRender: () => {} },
		present: (items: Component[]) => {
			for (const item of items) chat.addChild(item);
		},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	const liveText = () => Bun.stripANSI(chat.renderViewport(80, 20, frame()).join("\n"));

	helpers.showStatus("Viewing agent Side-1");
	const committed = chat.peekFlushBatch(80);
	if (!committed) throw new Error("expected the status to be flushable");
	chat.acknowledgeFinalizedBatch(committed.id);

	helpers.showStatus("No subagents in this session");
	expect(liveText()).toContain("No subagents in this session");

	// While the previous status is still live, the next one keeps replacing it in place.
	helpers.showStatus("Returned to main session");
	expect(liveText()).toContain("Returned to main session");
	expect(liveText()).not.toContain("No subagents in this session");
});
