import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError } from "@oh-my-pi/pi-agent-core/compaction";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { createCompactionSummaryMessage } from "../../session/messages";
import { CompactionSummaryMessageComponent } from "../components/compaction-summary-message";
import { TranscriptContainer } from "../components/transcript-container";
import { initTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { UiHelpers } from "../utils/ui-helpers";
import { CommandController } from "./command-controller";
import { EventController } from "./event-controller";

await Settings.init();
await initTheme(false, false, "proto");
const noop = () => {};

for (const mode of ["auto context-full", "auto remote", "manual"] as const) {
	test.each([false, true])(
		`${mode} retains immutable history and live tail (summary already published=%s)`,
		async published => {
			const chatContainer = new TranscriptContainer();
			const archived = new Text("ANS0176", 0, 0);
			chatContainer.addChild(archived);
			const tape: string[] = [];
			const flush = () => {
				for (let batch = chatContainer.peekFlushBatch(30); batch; batch = chatContainer.peekFlushBatch(30)) {
					tape.push(...batch.rows);
					chatContainer.acknowledgeFinalizedBatch(batch.id);
				}
			};
			flush();
			const live = { render: () => ["LIVE TAIL"], isTranscriptBlockFinalized: () => false };
			chatContainer.addChild(live);
			const summary = createCompactionSummaryMessage("new canonical summary", 1000, "2026-01-01T00:00:00Z", {
				method: "remote",
				tokensAfter: 25,
			});
			const messages: AgentMessage[] = [{ role: "user", content: "ANS0176", timestamp: 0 }, summary];
			const added: AgentMessage[] = [];
			let queueFlushed = false;
			const context = {
				isInitialized: true,
				init: async () => {},
				chatContainer,
				ui: { requestRender: noop, requestComponentRender: noop, terminal: { setProgress: noop } },
				settings: { get: () => false },
				viewSession: {
					isStreaming: false,
					buildTranscriptSessionContext: () => ({ messages: messages.map(message => ({ ...message })) }),
				},
				session: {
					compact: async () => ({ summary: summary.summary, firstKeptEntryId: "tail", tokensBefore: 1000 }),
				},
				statusContainer: new Container(),
				statusLine: { invalidate: noop },
				toolOutputExpanded: false,
				lastAssistantUsage: { input: 1000 },
				flushCompactionQueue: async () => {
					queueFlushed = true;
				},
				addMessageToChat: (message: AgentMessage) => {
					added.push(message);
					return helpers.addMessageToChat(message);
				},
				rebuildChatFromMessages: () => {
					chatContainer.clear();
					chatContainer.addChild(archived);
					helpers.addMessageToChat(summary);
					chatContainer.addChild(live);
				},
			} as unknown as InteractiveModeContext;
			const helpers = new UiHelpers(context);
			const controller = new EventController(context);
			if (published) helpers.addMessageToChat(summary);
			try {
				if (mode === "manual") await new CommandController(context).executeCompaction();
				else
					for (let delivery = 0; delivery < 2; delivery++)
						await controller.handleEvent({
							type: "auto_compaction_end",
							action: mode === "auto remote" ? "remote" : "context-full",
							result: { summary: summary.summary, firstKeptEntryId: "tail", tokensBefore: 1000 },
							aborted: false,
							willRetry: false,
						});
				flush();
				expect(tape.join("\n").match(/ANS0176/g)).toHaveLength(1);
				expect(chatContainer.children).toContain(live);
				expect(chatContainer.blockStates()[0]).toBe("committed");
				expect(added).toEqual(published ? [] : [summary]);
				expect(
					chatContainer.children.filter(child => child instanceof CompactionSummaryMessageComponent),
				).toHaveLength(1);
				expect(context.lastAssistantUsage).toBeUndefined();
				expect(queueFlushed).toBe(true);
				expect(messages).toHaveLength(2);
			} finally {
				controller.dispose();
				chatContainer.dispose();
			}
		},
	);
}

for (const outcome of ["aborted", "skipped", "error"] as const) {
	test(`automatic ${outcome} maintenance leaves the transcript unchanged`, async () => {
		const chatContainer = new TranscriptContainer();
		const existing = new Text("KEEP", 0, 0);
		chatContainer.addChild(existing);
		const notices: string[] = [];
		let flushed = false;
		const context = {
			isInitialized: true,
			init: async () => {},
			chatContainer,
			ui: { requestRender: noop, requestComponentRender: noop, terminal: { setProgress: noop } },
			settings: { get: () => false },
			viewSession: { isStreaming: false },
			showStatus: (text: string) => notices.push(text),
			showWarning: (text: string) => notices.push(text),
			flushCompactionQueue: async () => {
				flushed = true;
			},
		} as unknown as InteractiveModeContext;
		const controller = new EventController(context);
		try {
			await controller.handleEvent({
				type: "auto_compaction_end",
				action: "context-full",
				result: undefined,
				aborted: outcome === "aborted",
				skipped: outcome === "skipped",
				errorMessage: outcome === "error" ? "fixture failure" : undefined,
				willRetry: false,
			});
			expect(chatContainer.children).toEqual([existing]);
			expect(notices).toHaveLength(outcome === "skipped" ? 0 : 1);
			expect(flushed).toBe(true);
		} finally {
			controller.dispose();
			chatContainer.dispose();
		}
	});
}

test.each([false, true])("manual compaction failure/cancellation keeps history (cancelled=%s)", async cancelled => {
	const chatContainer = new TranscriptContainer();
	const existing = new Text("KEEP", 0, 0);
	chatContainer.addChild(existing);
	const notices: string[] = [];
	let flushed = false;
	const context = {
		chatContainer,
		ui: { requestRender: noop, requestComponentRender: noop },
		statusContainer: new Container(),
		session: {
			compact: async () => {
				throw cancelled ? new CompactionCancelledError() : Error("fixture failure");
			},
		},
		showError: (text: string) => notices.push(text),
		flushCompactionQueue: async () => {
			flushed = true;
		},
	} as unknown as InteractiveModeContext;
	try {
		expect(await new CommandController(context).executeCompaction()).toBe(cancelled ? "cancelled" : "failed");
		expect(chatContainer.children).toEqual([existing]);
		expect(notices).toEqual([cancelled ? "Compaction cancelled" : "Compaction failed: fixture failure"]);
		expect(flushed).toBe(true);
	} finally {
		chatContainer.dispose();
	}
});
