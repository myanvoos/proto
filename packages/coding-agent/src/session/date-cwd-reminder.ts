import type { Context, Message } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };

export function renderDateCwdReminder(date: string, cwd: string): string {
	return prompt.render(dateCwdReminderTemplate, { date, cwd }).trim();
}

const injectCache = new WeakMap<Message, { reminder: string; injected: Message }>();

export function injectDateCwdReminder(messages: Message[], reminder: string): Message[] {
	const index = messages.findIndex(message => message.role === "user");
	if (index < 0) return messages;
	const first = messages[index]!;
	if (typeof first.content === "string") {
		if (first.content.startsWith(reminder)) return messages;
	} else if (first.content[0]?.type === "text" && first.content[0].text === reminder) {
		return messages;
	}
	const cached = injectCache.get(first);
	if (cached !== undefined && cached.reminder === reminder) {
		const out = messages.slice();
		out[index] = cached.injected;
		return out;
	}
	const content =
		typeof first.content === "string"
			? `${reminder}\n\n${first.content}`
			: ([{ type: "text", text: reminder }, ...first.content] as Message["content"]);
	const injected = { ...first, content } as Message;
	injectCache.set(first, { reminder, injected });
	const out = messages.slice();
	out[index] = injected;
	return out;
}

export function withDateCwdReminder(context: Context, date: string, cwd: string): Context {
	if (!context.systemPrompt || context.systemPrompt.length === 0) return context;
	if (context.messages.length === 0) return context;
	const reminder = renderDateCwdReminder(date, cwd);
	const messages = injectDateCwdReminder(context.messages, reminder);
	return messages === context.messages ? context : { ...context, messages };
}
