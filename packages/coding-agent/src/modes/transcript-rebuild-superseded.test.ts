import { expect, test } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { Settings } from "../config/settings";
import type { SessionContext } from "../session/session-context";
import { TranscriptContainer } from "./components/transcript-container";
import { initTheme } from "./theme/theme";
import type { InteractiveModeContext } from "./types";
import { UiHelpers } from "./utils/ui-helpers";

await Settings.init();
await initTheme(false, false, "proto");

function replayContext() {
	const chat = new TranscriptContainer();
	chat.addChild(new Text("visible-before-replay", 0, 0));
	let label = "first";
	let fail = false;
	const paints: boolean[] = [];
	const ctx = {
		chatContainer: chat,
		initialChatRendered: true,
		pendingTools: new Map(),
		pendingShellContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap(),
		viewSession: {
			isStreaming: false,
			buildTranscriptSessionContext: () => {
				if (fail) throw new Error("context unavailable");
				return { messages: [], window: { start: 0, end: 0, pageFromLatest: 0, totalMessages: 0 }, label };
			},
			sessionManager: { getEntryCount: () => 0 },
		},
		ui: { requestRender: (full = false) => paints.push(full) },
		updatePendingMessagesDisplay: () => {},
		renderSessionContextIncrementally: async (context: SessionContext) => {
			ctx.chatContainer.addChild(new Text((context as SessionContext & { label: string }).label, 0, 0));
		},
	};
	return {
		ctx,
		chat,
		paints,
		helper: new UiHelpers(ctx as unknown as InteractiveModeContext),
		setLabel: (next: string) => {
			label = next;
		},
		setFail: (next: boolean) => {
			fail = next;
		},
	};
}

test("a superseded in-flight transcript replay never paints the old session over the new view", async () => {
	const { ctx, chat, paints, helper, setLabel } = replayContext();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const render = ctx.renderSessionContextIncrementally;
	let first = true;
	ctx.renderSessionContextIncrementally = async context => {
		await render(context);
		if (first) {
			first = false;
			started.resolve();
			await release.promise;
		}
	};
	const obsolete = helper.renderInitialMessages();
	await started.promise;
	setLabel("latest");
	const latest = helper.renderInitialMessages();
	expect(ctx.initialChatRendered).toBe(false);
	release.resolve();
	await Promise.all([obsolete, latest]);
	expect(chat.render(80).map(line => line.trimEnd())).toEqual(["latest"]);
	expect(paints).toEqual([true]);
	expect(ctx.initialChatRendered).toBe(true);
});

test("a context-construction failure reopens live display and leaves the visible transcript intact", async () => {
	const { ctx, chat, helper, setFail, setLabel } = replayContext();
	setFail(true);
	await expect(helper.renderInitialMessages()).rejects.toThrow("context unavailable");
	expect(ctx.initialChatRendered).toBe(true);
	expect(chat.render(80).map(line => line.trimEnd())).toEqual(["visible-before-replay"]);
	setFail(false);
	setLabel("recovered");
	await helper.renderInitialMessages();
	expect(chat.render(80).map(line => line.trimEnd())).toEqual(["recovered"]);
	expect(ctx.initialChatRendered).toBe(true);
});
