import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import type { BuildSessionContextOptions, SessionContext } from "../../session/session-context";
import { SessionManager } from "../../session/session-manager";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { UiHelpers } from "./ui-helpers";

await Settings.init();
await initTheme(false, false, "proto");

const noop = () => {};
function assistant(index: number, text = `assistant-${index}`): AssistantMessage {
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
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

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

type RenderRequest = [immediate?: boolean, options?: { clearScrollback?: boolean }];

function windowingContext(messages: AssistantMessage[]): {
	ctx: InteractiveModeContext;
	renders: AgentMessage[][];
	renderRequests: RenderRequest[];
	manager: SessionManager;
} {
	const renders: AgentMessage[][] = [];
	const manager = SessionManager.inMemory();
	for (const message of messages) manager.appendMessage(message);
	const renderRequests: RenderRequest[] = [];
	const ctx = {
		ui: {
			requestRender: (immediate?: boolean, options?: { clearScrollback?: boolean }) =>
				renderRequests.push([immediate, options]),
		},
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
			buildTranscriptSessionContext: (options?: BuildSessionContextOptions) =>
				manager.buildSessionContext({ ...options, transcript: true }),
			sessionManager: manager,
		},
		renderSessionContextIncrementally: async (context: SessionContext) => {
			renders.push(context.messages);
			for (const message of context.messages)
				ctx.chatContainer.addChild(
					new DisposableBlock(
						message.role === "assistant" && message.content[0]?.type === "text"
							? message.content[0].text
							: message.role,
					),
				);
		},
		renderSessionContext: (context: SessionContext) => renders.push(context.messages),
	} as unknown as InteractiveModeContext;
	return { ctx, renders, renderRequests, manager };
}

test("navigation disposes pages, preserves queued UI, exits history before streaming, and resets on rebuild", async () => {
	const messages = Array.from({ length: 600 }, (_, i) => assistant(i));
	const { ctx, renders, renderRequests, manager } = windowingContext(messages);
	const old = new DisposableBlock("old");
	ctx.chatContainer.addChild(old);
	const helper = new UiHelpers(ctx);
	await helper.renderInitialMessages();
	expect(renders.at(-1)?.[0]).toEqual(messages[344]);
	expect(renderRequests.at(-1)).toEqual([true, { clearScrollback: true }]);
	expect(old.disposed).toBe(true);
	const queued = new DisposableBlock("queued");
	ctx.pendingMessagesContainer.addChild(queued);
	const latest = ctx.chatContainer.children.filter(
		(child: Component) => child instanceof DisposableBlock,
	) as DisposableBlock[];
	await helper.navigateTranscriptHistory("older");
	expect(renders.at(-1)?.[0]).toEqual(messages[88]);
	const rebuildSelection = helper.getVisibleTranscriptContext();
	expect(rebuildSelection.context.messages).toHaveLength(256);
	expect(rebuildSelection.context.messages[0]).toEqual(messages[88]);
	expect(latest.every(child => child.disposed)).toBe(true);
	expect(queued.disposed).toBe(false);
	await helper.ensureLatestTranscriptWindow();
	expect(renders.at(-1)?.[0]).toEqual(messages[344]);
	Object.defineProperty(ctx.viewSession, "isStreaming", { value: true, configurable: true });
	await helper.navigateTranscriptHistory("older");
	expect(renders).toHaveLength(3);
	Object.defineProperty(ctx.viewSession, "isStreaming", { value: false, configurable: true });
	await helper.navigateTranscriptHistory("older");
	await helper.renderInitialMessages();
	expect(renders.at(-1)?.[0]).toEqual(messages[344]);
	ctx.chatContainer.dispose();
	await manager.close();
});

test("synthetic developer context the model acted on is invisible in the transcript during rebuild", () => {
	const chatContainer = new TranscriptContainer();
	const context = {
		ui: { requestRender: noop },
		chatContainer,
		pendingTools: new Map(),
		lastAssistantUsage: undefined,
		settings: { get: () => false },
		statusLine: { invalidate: noop },
		updateEditorBorderColor: noop,
		toolOutputExpanded: false,
		hideToolActivity: false,
		transcriptMessageComponents: new WeakMap<object, WeakRef<Component>>(),
		viewSession: {
			isStreaming: false,
			extensionRunner: undefined,
			retryAttempt: undefined,
			getToolByName: () => undefined,
			hasBuiltInTool: () => false,
			sessionManager: { putBlobSync: noop },
		},
		addMessageToChat: noop,
	} as unknown as InteractiveModeContext;
	const helper = new UiHelpers(context);
	context.addMessageToChat = helper.addMessageToChat.bind(helper);
	const sessionContext = {
		messages: [
			{
				role: "developer",
				content: "Synthetic developer context\tthe model acted on is visible after rebuild.",
				timestamp: 1,
			},
		],
		models: {},
		injectedTtsrRules: [],
		mode: "normal",
	} as unknown as SessionContext;

	try {
		helper.renderSessionContext(sessionContext);
		const rendered = Bun.stripANSI(chatContainer.render(160).join("\n"));
		expect(rendered).toContain("Synthetic developer context");
		expect(rendered).toContain("the model acted on is visible after rebuild.");
		expect(rendered).not.toContain("\t");
	} finally {
		chatContainer.dispose();
	}
});
