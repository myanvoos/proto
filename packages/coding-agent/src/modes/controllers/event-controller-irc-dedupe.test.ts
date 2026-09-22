import { expect, test } from "bun:test";
import { initTheme } from "../theme/theme";
import { EventController } from "./event-controller";

await initTheme(false, false, "proto");

const NOOP = () => {};
const UI = {
	requestRender: NOOP,
	requestComponentRender: NOOP,
	resetDisplay: NOOP,
	terminal: { setProgress: NOOP },
};

function ircRecord(id: string, body: string, timestamp: number) {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: `[IRC from \`peer\`]\n\n${body}`,
		display: true,
		details: { id, from: "peer", message: body },
		attribution: "agent",
		timestamp,
	} as const;
}

function makeContext(cardLog: unknown[]) {
	const chatContainer = {
		children: [] as unknown[],
		canRemoveBlock: () => true,
		removeChild: (child: unknown) => {
			const index = chatContainer.children.indexOf(child);
			if (index >= 0) chatContainer.children.splice(index, 1);
		},
	};
	const context = {
		isInitialized: true,
		ui: UI,
		chatContainer,
		settings: { get: () => false },
		viewSession: { isStreaming: false },
		session: { isAborting: false },
		statusLine: { invalidate: NOOP, markActivityEnd: NOOP, markActivityStart: NOOP },
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		statusContainer: { disposeChildren: NOOP },
		ensureLoadingAnimation: NOOP,
		setWorkingMessage: NOOP,
		optimisticSkillMessagePending: false,
		// One rendered card per accepted message; deduped replays never call this.
		addMessageToChat: (message: unknown) => {
			const card = { message };
			chatContainer.children.push(card);
			cardLog.push(message);
			return [card];
		},
	};
	return context;
}

test("the same IRC record delivered as irc_message and message_start renders one card", async () => {
	const cardLog: unknown[] = [];
	const context = makeContext(cardLog);
	const controller = new EventController(context as unknown as ConstructorParameters<typeof EventController>[0]);
	const record = ircRecord("irc-1", "hello", 1234);

	try {
		await controller.handleEvent({ type: "irc_message", message: record } as never);
		// flushPending() replays queued records through message_start.
		await controller.handleEvent({ type: "message_start", message: record } as never);
		expect(cardLog).toHaveLength(1);

		// Two distinct same-millisecond records must not collide.
		const a = ircRecord("irc-2", "first", 5678);
		const b = ircRecord("irc-3", "second", 5678);
		await controller.handleEvent({ type: "irc_message", message: a } as never);
		await controller.handleEvent({ type: "irc_message", message: b } as never);
		expect(cardLog).toHaveLength(3);
	} finally {
		controller.dispose();
	}
});

test("non-IRC custom records sharing a details.id are distinct messages", async () => {
	const cardLog: unknown[] = [];
	const context = makeContext(cardLog);
	const controller = new EventController(context as unknown as ConstructorParameters<typeof EventController>[0]);

	const progress = (id: string, body: string) =>
		({
			role: "custom",
			customType: "extension:progress",
			content: body,
			display: true,
			details: { id },
			attribution: "agent",
			timestamp: 99,
		}) as never;

	try {
		await controller.handleEvent({ type: "message_start", message: progress("job-1", "10%") } as never);
		await controller.handleEvent({ type: "message_start", message: progress("job-1", "20%") } as never);
		// Extension ids are not delivery identities: both records render.
		expect(cardLog).toHaveLength(2);
	} finally {
		controller.dispose();
	}
});
