import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { DateCwdReminderInjector, renderDateCwdReminder } from "./date-cwd-reminder";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

describe("DateCwdReminderInjector", () => {
	it("keeps prior reminder bytes and moves a changed reminder to the next user turn", () => {
		const injector = new DateCwdReminderInjector();
		const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
		const first = injector.transform({ systemPrompt: ["system"], messages: [firstUser] }, "2026-08-14", "/old");
		const firstInjected = first.messages[0]!;
		const secondUser: Message = { role: "user", content: "second", timestamp: 3 };

		const second = injector.transform(
			{ systemPrompt: ["system"], messages: [firstUser, assistant("done"), secondUser] },
			"2026-08-15",
			"/new",
		);

		expect(second.messages[0]).toBe(firstInjected);
		expect(second.messages[2]?.content).toBe(`${renderDateCwdReminder("2026-08-15", "/new")}\n\nsecond`);
		expect(firstUser.content).toBe("first");
		expect(secondUser.content).toBe("second");
	});

	it("appends a developer reminder after the tail when the change arrives without a new user turn", () => {
		const injector = new DateCwdReminderInjector();
		const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
		const reply = assistant("working");
		injector.transform({ systemPrompt: ["system"], messages: [firstUser] }, "2026-08-14", "/work");
		const context: Context = { systemPrompt: ["system"], messages: [firstUser, reply] };

		const next = injector.transform(context, "2026-08-15", "/work");

		expect(next.messages).toHaveLength(3);
		expect(next.messages[1]).toBe(reply);
		expect(next.messages[2]).toMatchObject({
			role: "developer",
			content: renderDateCwdReminder("2026-08-15", "/work"),
		});
	});

	it("reuses injected message objects on provider request replay", () => {
		const injector = new DateCwdReminderInjector();
		const firstUser: Message = { role: "user", content: "first", timestamp: 1 };
		const context: Context = { systemPrompt: ["system"], messages: [firstUser] };

		const first = injector.transform(context, "2026-08-14", "/work");
		const replay = injector.transform({ ...context, messages: [...context.messages] }, "2026-08-14", "/work");

		expect(replay.messages[0]).toBe(first.messages[0]);
	});
});
