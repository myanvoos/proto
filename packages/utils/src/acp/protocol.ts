export interface Meta {
	_meta?: Record<string, unknown> | null;
}

export type MaybePromise<T> = T | Promise<T>;

export type ProtocolVersion = number;

export const PROTOCOL_VERSION = 1;

export type SessionId = string;

export type ToolCallId = string;

export type ToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "switch_mode"
	| "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface TextContent extends Meta {
	type: "text";
	text: string;
}

export interface ImageContent extends Meta {
	type: "image";
	data: string;
	mimeType: string;
}

export interface AudioContent extends Meta {
	type: "audio";
	data: string;
	mimeType: string;
}

export interface ResourceLink extends Meta {
	type: "resource_link";
	uri: string;
	name?: string;
	title?: string;
	mimeType?: string | null;
	description?: string | null;
	size?: number | null;
}

export type EmbeddedResourceValue = (
	| { uri: string; text: string; mimeType?: string }
	| { uri: string; blob: string; mimeType?: string }
) &
	Meta;

export interface EmbeddedResource extends Meta {
	type: "resource";
	resource: EmbeddedResourceValue;
}

export type ContentBlock = TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource;

export interface ToolContent extends Meta {
	type: "content";
	content: ContentBlock;
}

export interface ToolDiff extends Meta {
	type: "diff";
	path: string;
	oldText?: string | null;
	newText: string;
}

export interface ToolTerminal extends Meta {
	type: "terminal";
	terminalId: string;
}

export type ToolCallContent = ToolContent | ToolDiff | ToolTerminal;

export interface ToolCallLocation extends Meta {
	path: string;
	line?: number | null;
}

export interface ToolCall extends Meta {
	toolCallId: ToolCallId;
	title: string;
	kind?: ToolKind | null;
	status?: ToolCallStatus | null;
	content?: ToolCallContent[] | null;
	locations?: ToolCallLocation[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface ToolCallUpdate extends Meta {
	toolCallId: ToolCallId;
	title?: string | null;
	kind?: ToolKind | null;
	status?: ToolCallStatus | null;
	content?: ToolCallContent[] | null;
	locations?: ToolCallLocation[] | null;
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface PermissionOption extends Meta {
	optionId: string;
	name: string;
	kind: PermissionOptionKind;
}

export interface RequestPermissionRequest extends Meta {
	sessionId: SessionId;
	toolCall: ToolCallUpdate;
	options: PermissionOption[];
}

export interface RequestPermissionResponse extends Meta {
	outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
}

export interface FileSystemCapabilities {
	readTextFile?: boolean;
	writeTextFile?: boolean;
}

export interface ClientCapabilities {
	fs?: FileSystemCapabilities;
	terminal?: boolean;
	auth?: { terminal?: boolean };
	elicitation?: { form?: Record<string, unknown>; url?: Record<string, unknown> };
	_meta?: Record<string, unknown>;
}

export interface Implementation {
	name: string;
	version: string;
	title?: string;
}

export interface InitializeRequest extends Meta {
	protocolVersion: ProtocolVersion;
	clientCapabilities?: ClientCapabilities;
	clientInfo?: Implementation | null;
}

export interface AuthMethodEnvVar extends Meta {
	type: "env_var";
	id: string;
	name: string;
	description?: string | null;
	variable: string;
}

export interface AuthMethodTerminal extends Meta {
	type: "terminal";
	id: string;
	name: string;
	description?: string | null;
	command?: string;
	args?: string[];
}

export interface AuthMethodAgent extends Meta {
	type?: "agent";
	id: string;
	name: string;
	description?: string | null;
}

export type AuthMethod = AuthMethodEnvVar | AuthMethodTerminal | AuthMethodAgent;

export interface InitializeResponse extends Meta {
	protocolVersion: ProtocolVersion;
	agentCapabilities?: Record<string, unknown>;
	authMethods?: AuthMethod[];
	agentInfo?: Implementation | null;
}

export interface AuthenticateRequest extends Meta {
	methodId: string;
}

export interface AuthenticateResponse extends Meta {}

export type McpServer = (
	| { type?: "stdio"; name: string; command: string; args?: string[]; env: Array<{ name: string; value: string }> }
	| { type: "http" | "sse" | "acp"; name: string; url: string; headers: Array<{ name: string; value: string }> }
) &
	Meta;

export interface SessionMode extends Meta {
	id: string;
	name: string;
	description?: string | null;
}

export interface SessionModeState extends Meta {
	currentModeId: string;
	availableModes: SessionMode[];
}

export interface SessionConfigSelectOption extends Meta {
	value: string;
	name: string;
	description?: string | null;
}

export type SessionConfigOption = (
	| { type: "select"; currentValue: string; options: SessionConfigSelectOption[] }
	| { type: "boolean"; currentValue: boolean }
) & { id: string; name: string; description?: string | null; category?: string | null } & Meta;

export interface SessionSetupRequest extends Meta {
	cwd: string;
	mcpServers: McpServer[];
	additionalDirectories?: string[];
}

export interface NewSessionRequest extends SessionSetupRequest {}

export interface NewSessionResponse extends Meta {
	sessionId: SessionId;
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
}

export interface LoadSessionRequest extends SessionSetupRequest {
	sessionId: SessionId;
}

export interface LoadSessionResponse extends Meta {
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[] | null;
}

export interface ResumeSessionRequest extends LoadSessionRequest {}

export interface ResumeSessionResponse extends LoadSessionResponse {}

export interface ForkSessionRequest extends LoadSessionRequest {}

export interface ForkSessionResponse extends NewSessionResponse {}

export interface CloseSessionRequest extends Meta {
	sessionId: SessionId;
}

export interface CloseSessionResponse extends Meta {}

export interface ListSessionsRequest extends Meta {
	cwd?: string | null;
	cursor?: string | null;
	additionalDirectories?: string[];
}

export interface SessionInfo extends Meta {
	sessionId: SessionId;
	cwd: string;
	additionalDirectories?: string[];
	title?: string | null;
	updatedAt?: string | null;
}

export interface ListSessionsResponse extends Meta {
	sessions: SessionInfo[];
	nextCursor?: string | null;
}

export interface SetSessionModeRequest extends Meta {
	sessionId: SessionId;
	modeId: string;
}

export interface SetSessionModeResponse extends Meta {}

export interface SetSessionConfigOptionRequest extends Meta {
	sessionId: SessionId;
	configId: string;
	value: string | boolean;
}

export interface SetSessionConfigOptionResponse extends Meta {
	configOptions: SessionConfigOption[];
}

export interface AvailableCommand extends Meta {
	name: string;
	description: string;
	input?: { hint: string } | null;
}

export interface PlanEntry extends Meta {
	content: string;
	priority: "high" | "medium" | "low";
	status: "pending" | "in_progress" | "completed";
}

export type SessionUpdate =
	| ({
			sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
			content: ContentBlock;
			messageId?: string;
	  } & Meta)
	| ({ sessionUpdate: "tool_call" } & ToolCall)
	| ({ sessionUpdate: "tool_call_update" } & ToolCallUpdate)
	| ({ sessionUpdate: "plan"; entries: PlanEntry[] } & Meta)
	| ({ sessionUpdate: "current_mode_update"; currentModeId: string } & Meta)
	| ({ sessionUpdate: "config_option_update"; configOptions: SessionConfigOption[] } & Meta)
	| ({ sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] } & Meta)
	| ({ sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null } & Meta)
	| ({
			sessionUpdate: "usage_update";
			size: number;
			used: number;
			cost?: { amount: number; currency: string } | null;
	  } & Meta);

export interface SessionNotification extends Meta {
	sessionId: SessionId;
	update: SessionUpdate;
}

export interface PromptRequest extends Meta {
	sessionId: SessionId;
	prompt: ContentBlock[];
}

export interface Usage extends Meta {
	totalTokens: number;
	inputTokens: number;
	outputTokens: number;
	cachedReadTokens?: number | null;
	cachedWriteTokens?: number | null;
	thoughtTokens?: number | null;
}

export interface PromptResponse extends Meta {
	stopReason: StopReason;
	usage?: Usage | null;
}

export interface ReadTextFileRequest extends Meta {
	sessionId: string;
	path: string;
	line?: number | null;
	limit?: number | null;
}

export interface ReadTextFileResponse extends Meta {
	content: string;
}

export interface WriteTextFileRequest extends Meta {
	sessionId: string;
	path: string;
	content: string;
}

export interface WriteTextFileResponse extends Meta {}

export interface CreateTerminalRequest extends Meta {
	sessionId: string;
	command: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	cwd?: string;
	outputByteLimit?: number;
}

export interface TerminalOutputResponse extends Meta {
	output: string;
	truncated: boolean;
	exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
}

export interface WaitForTerminalExitResponse extends Meta {
	exitCode?: number | null;
	signal?: string | null;
}

export interface TerminalActionResponse extends Meta {}

export type ElicitationContentValue = string | number | boolean | string[];

export type ElicitationPropertySchema = Record<string, unknown> & {
	type: string;
	title?: string;
	description?: string;
};

export type CreateElicitationRequest =
	| ({
			mode: "form";
			sessionId: string;
			message: string;
			requestedSchema: {
				type: "object";
				properties: Record<string, ElicitationPropertySchema>;
				required?: string[];
			};
	  } & Meta)
	| ({ mode: "url"; sessionId: string; message: string; url: string; elicitationId: string } & Meta)
	| ({
			mode: string;
			sessionId: string;
			message: string;
			requestedSchema?: {
				type: "object";
				properties: Record<string, ElicitationPropertySchema>;
				required?: string[];
			};
			url?: string;
			elicitationId?: string;
	  } & Meta);

export type CreateElicitationResponse =
	| ({ action: "accept"; content: Record<string, ElicitationContentValue> } & Meta)
	| ({ action: "decline" | "cancel"; content?: never } & Meta)
	| ({ action: string; content?: Record<string, ElicitationContentValue> } & Meta);

export interface CompleteElicitationNotification extends Meta {
	sessionId: string;
	elicitationId: string;
}

export interface Agent {
	initialize(params: InitializeRequest): MaybePromise<InitializeResponse>;
	newSession(params: NewSessionRequest): MaybePromise<NewSessionResponse>;
	prompt(params: PromptRequest): MaybePromise<PromptResponse>;
	cancel(params: { sessionId: string }): MaybePromise<void>;
	authenticate?(params: AuthenticateRequest): MaybePromise<AuthenticateResponse | void>;
	loadSession?(params: LoadSessionRequest): MaybePromise<LoadSessionResponse | void>;
	listSessions?(params: ListSessionsRequest): MaybePromise<ListSessionsResponse>;
	resumeSession?(params: ResumeSessionRequest): MaybePromise<ResumeSessionResponse>;
	unstable_forkSession?(params: ForkSessionRequest): MaybePromise<ForkSessionResponse>;
	closeSession?(params: CloseSessionRequest): MaybePromise<CloseSessionResponse | void>;
	setSessionMode?(params: SetSessionModeRequest): MaybePromise<SetSessionModeResponse | void>;
	setSessionConfigOption?(params: SetSessionConfigOptionRequest): MaybePromise<SetSessionConfigOptionResponse>;
	extMethod?(method: string, params: Record<string, unknown>): MaybePromise<Record<string, unknown>>;
	extNotification?(method: string, params: Record<string, unknown>): MaybePromise<void>;
}
