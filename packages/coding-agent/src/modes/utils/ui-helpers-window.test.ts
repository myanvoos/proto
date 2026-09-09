import { expect, test } from "bun:test";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme } from "../theme/theme";
import { selectTranscriptWindow, transcriptWindowContext, UiHelpers } from "./ui-helpers";

await Settings.init();
await initTheme(false, false, "proto");

const noop = () => {};
function assistant(index: number, text = `assistant-${index}`): any {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		api: "openai-completions",
		provider: "test",
		model: "test",
		timestamp: index,
		usage: {
			input: index + 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: index + 2,
			cost: { input: 0, output: 0, total: 0 },
		},
	};
}

test("bounds a single-user autonomous assistant history", () => {
	const messages = [
		{ role: "user", content: "initial", timestamp: 0 } as any,
		...Array.from({ length: 40_000 }, (_, i) => assistant(i)),
	];
	expect(selectTranscriptWindow(messages, 0, 256, Number.MAX_SAFE_INTEGER)).toEqual({
		start: 39_745,
		end: 40_001,
		pageFromLatest: 0,
		totalMessages: 40_001,
	});
	expect(selectTranscriptWindow(messages, 1, 256, Number.MAX_SAFE_INTEGER)).toEqual({
		start: 39_489,
		end: 39_745,
		pageFromLatest: 1,
		totalMessages: 40_001,
	});
	expect(messages).toHaveLength(40_001);
});

test("keeps matching assistant tool results atomic across both soft limits", () => {
	const ids = ["a", "b", "c"];
	const toolCall = {
		...assistant(1, "tool turn"),
		content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}-${"x".repeat(80)}` } })),
	};
	const results = ids.map(toolCallId => ({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 2,
	}));
	const messages = [assistant(0), toolCall, ...results, assistant(2)];
	expect(selectTranscriptWindow(messages, 0, 2, 100)).toMatchObject({ start: 5, end: 6 });
	const older = selectTranscriptWindow(messages, 1, 2, 100);
	expect(older).toMatchObject({ start: 1, end: 5 });
	expect(older.end - older.start, "one indivisible group may exceed soft caps").toBe(4);
});

test("slices only display context, leaving provider history unchanged", () => {
	const messages = Array.from({ length: 300 }, (_, i) => assistant(i));
	const context: any = {
		messages,
		cacheMissExplainedAt: messages.map((_, i) => i % 2 === 0),
		models: { default: "test/model" },
		injectedTtsrRules: [],
		mode: "normal",
	};
	const display = transcriptWindowContext(context, selectTranscriptWindow(messages, 0, 32, Number.MAX_SAFE_INTEGER));
	expect(display.messages).toHaveLength(32);
	expect(display.messages[0]).toBe(messages[268]);
	expect(display.cacheMissExplainedAt).toEqual(context.cacheMissExplainedAt.slice(268));
	expect(context.messages).toBe(messages);
	expect(context.messages).toHaveLength(300);
});
class DisposableBlock implements Component {
	disposed = false;
	constructor(readonly label: string) {}
	render(): readonly string[] {
		return [this.label];
	}
	dispose(): void {
		this.disposed = true;
	}
}

function windowingContext(messages: any[]): { ctx: any; renders: any[][] } {
	const renders: any[][] = [];
	const ctx: any = {
		ui: { requestRender: noop },
		chatContainer: new TranscriptContainer(),
		pendingMessagesContainer: new Container(),
		pendingTools: new Map(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap(),
		initialChatRendered: true,
		hideToolActivity: false,
		lastAssistantUsage: undefined,
		showStatus: noop,
		viewSession: {
			isStreaming: false,
			buildTranscriptSessionContext: () => ({ messages, models: {}, injectedTtsrRules: [], mode: "normal" }),
			sessionManager: { getEntries: () => [] },
		},
		renderSessionContextIncrementally: async (context: any) => {
			renders.push(context.messages);
			for (const message of context.messages)
				ctx.chatContainer.addChild(new DisposableBlock(message.content[0].text));
		},
		renderSessionContext: (context: any) => renders.push(context.messages),
	};
	return { ctx, renders };
}

test("navigation disposes pages, preserves queued UI, exits history before streaming, and resets on rebuild", async () => {
	const messages = Array.from({ length: 600 }, (_, i) => assistant(i));
	const { ctx, renders } = windowingContext(messages);
	const old = new DisposableBlock("old");
	ctx.chatContainer.addChild(old);
	const helper = new UiHelpers(ctx);
	await helper.renderInitialMessages();
	expect(renders.at(-1)?.[0]).toBe(messages[344]);
	expect(old.disposed).toBe(true);
	const queued = new DisposableBlock("queued");
	ctx.pendingMessagesContainer.addChild(queued);
	const latest = ctx.chatContainer.children.filter(
		(child: Component) => child instanceof DisposableBlock,
	) as DisposableBlock[];
	await helper.navigateTranscriptHistory("older");
	expect(renders.at(-1)?.[0]).toBe(messages[88]);
	const rebuildSelection = helper.selectVisibleTranscriptContext({
		messages,
		models: {},
		injectedTtsrRules: [],
		mode: "normal",
	});
	expect(rebuildSelection.context.messages).toHaveLength(256);
	expect(rebuildSelection.context.messages[0]).toBe(messages[88]);
	expect(latest.every(child => child.disposed)).toBe(true);
	expect(queued.disposed).toBe(false);
	await helper.ensureLatestTranscriptWindow();
	expect(renders.at(-1)?.[0]).toBe(messages[344]);
	ctx.viewSession.isStreaming = true;
	await helper.navigateTranscriptHistory("older");
	expect(renders).toHaveLength(3);
	ctx.viewSession.isStreaming = false;
	await helper.navigateTranscriptHistory("older");
	await helper.renderInitialMessages();
	expect(renders.at(-1)?.[0]).toBe(messages[344]);
});
