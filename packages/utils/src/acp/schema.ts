import type {
	ForkSessionResponse,
	LoadSessionResponse,
	NewSessionResponse,
	PromptResponse,
	SessionNotification,
} from "./protocol";

export interface ValidationError {
	issues: Array<{ path: Array<string | number>; message: string }>;
}

export interface ValidationSuccess<T> {
	success: true;
	data: T;
}

export interface ValidationFailure {
	success: false;
	error: ValidationError;
}

export interface Validator<T> {
	safeParse(value: unknown): ValidationSuccess<T> | ValidationFailure;
	parse(value: unknown): T;
}

function validator<T>(check: (value: unknown) => boolean, label: string): Validator<T> {
	return {
		safeParse(value) {
			return check(value)
				? { success: true, data: value as T }
				: { success: false, error: { issues: [{ path: [], message: `Invalid ${label}` }] } };
		},
		parse(value) {
			if (!check(value)) throw new Error(`Invalid ${label}`);
			return value as T;
		},
	};
}

function objectWithString(value: unknown, key: string): boolean {
	return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[key] === "string";
}

function validModes(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value !== "object" || value === null) return false;
	const modes = value as Record<string, unknown>;
	return (
		typeof modes.currentModeId === "string" &&
		Array.isArray(modes.availableModes) &&
		modes.availableModes.every(mode => objectWithString(mode, "id") && objectWithString(mode, "name"))
	);
}

function sessionResponse(value: unknown, needsId: boolean): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const response = value as Record<string, unknown>;
	if (needsId && typeof response.sessionId !== "string") return false;
	if (!validModes(response.modes)) return false;
	return (
		response.configOptions === undefined || response.configOptions === null || Array.isArray(response.configOptions)
	);
}

function contentBlock(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const block = value as Record<string, unknown>;
	switch (block.type) {
		case "text":
			return typeof block.text === "string";
		case "image":
		case "audio":
			return typeof block.data === "string" && typeof block.mimeType === "string";
		case "resource_link":
			return typeof block.uri === "string" && typeof block.name === "string";
		case "resource":
			return typeof block.resource === "object" && block.resource !== null;
		default:
			return false;
	}
}

function sessionNotification(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const notification = value as Record<string, unknown>;
	if (
		typeof notification.sessionId !== "string" ||
		typeof notification.update !== "object" ||
		notification.update === null
	)
		return false;
	const update = notification.update as Record<string, unknown>;
	if (typeof update.sessionUpdate !== "string") return false;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk":
		case "user_message_chunk":
			return contentBlock(update.content);
		case "tool_call":
			return typeof update.toolCallId === "string" && typeof update.title === "string";
		case "tool_call_update":
			return typeof update.toolCallId === "string";
		case "plan":
			return Array.isArray(update.entries);
		case "current_mode_update":
			return typeof update.currentModeId === "string";
		case "available_commands_update":
			return Array.isArray(update.availableCommands);
		case "config_option_update":
			return Array.isArray(update.configOptions);
		case "session_info_update":
			return update.title === undefined || update.title === null || typeof update.title === "string";
		case "usage_update":
			return typeof update.size === "number" && typeof update.used === "number";
		default:
			return false;
	}
}

export const zNewSessionResponse = validator<NewSessionResponse>(
	value => sessionResponse(value, true),
	"new session response",
);

export const zLoadSessionResponse = validator<LoadSessionResponse>(
	value => sessionResponse(value, false),
	"load session response",
);

export const zForkSessionResponse = validator<ForkSessionResponse>(
	value => sessionResponse(value, true),
	"fork session response",
);

export const zPromptResponse = validator<PromptResponse>(value => {
	if (typeof value !== "object" || value === null) return false;
	const stopReason = (value as Record<string, unknown>).stopReason;
	return (
		stopReason === "end_turn" ||
		stopReason === "max_tokens" ||
		stopReason === "max_turn_requests" ||
		stopReason === "refusal" ||
		stopReason === "cancelled"
	);
}, "prompt response");

export const zSessionNotification = validator<SessionNotification>(sessionNotification, "session notification");

export const schema = {
	zNewSessionResponse,
	zLoadSessionResponse,
	zForkSessionResponse,
	zPromptResponse,
	zSessionNotification,
} as const;
