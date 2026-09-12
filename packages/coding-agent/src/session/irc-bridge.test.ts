import { expect, test } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import type { IrcMessage } from "../irc/bus";
import { IrcBridge, type IrcBridgeHost } from "./irc-bridge";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";

test("a session switch clears queued IRC and suppresses a late auto-reply", async () => {
	let sessionId = "previous-session";
	const reply = Promise.withResolvers<{ replyText: string }>();
	const host = {
		agent: { steer: () => {} } as unknown as Agent,
		sessionManager: { getSessionId: () => sessionId } as unknown as SessionManager,
		settings: { get: () => false } as unknown as Settings,
		isDisposed: () => false,
		isStreaming: () => true,
		emitSessionEvent: async () => {},
		wakeForIrc: () => {},
		runEphemeralTurn: () => reply.promise,
	} satisfies IrcBridgeHost;
	const bridge = new IrcBridge(host);
	const message: IrcMessage = {
		id: "message-1",
		from: "old-peer",
		to: "Main",
		body: "old work is done",
		ts: Date.now(),
	};

	await bridge.deliver(message, { expectsReply: true });
	expect(bridge.drainPending()).toHaveLength(1);
	bridge.deferWake([
		{
			role: "custom",
			customType: "irc:incoming",
			content: "queued before switch",
			display: true,
			attribution: "agent",
			timestamp: Date.now(),
		} satisfies CustomMessage,
	]);

	sessionId = "current-session";
	bridge.reset();
	reply.resolve({ replyText: "late reply" });
	await Bun.sleep(0);

	expect(bridge.drainPending()).toEqual([]);
});
