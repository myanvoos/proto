import { type } from "@oh-my-pi/omptype";
import { TOOL_TIMEOUTS } from "../tools/tool-timeouts";

export const lspSchema = type({
	action:
		"'diagnostics' | 'definition' | 'references' | 'hover' | 'symbols' | 'rename' | 'rename_file' | 'code_actions' | 'type_definition' | 'implementation' | 'status' | 'reload' | 'capabilities' | 'request'",
	file: "string?",
	line: "number?",
	symbol: "string?",
	query: "string?",
	new_name: "string?",
	apply: "boolean?",
	"timeout?": type.number
		.atLeast(TOOL_TIMEOUTS.lsp.min)
		.atMost(TOOL_TIMEOUTS.lsp.max)
		.describe("Timeout in seconds (default 20; range 5–300)."),
	payload: "string?",
});

export type LspParams = typeof lspSchema.infer;

export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: LspParams;
}

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange: Range;
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4;

interface DiagnosticRelatedInformation {
	location: Location;
	message: string;
}

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	codeDescription?: { href: string };
	source?: string;
	message: string;
	tags?: number[];
	relatedInformation?: DiagnosticRelatedInformation[];
	data?: unknown;
}

export interface PublishedDiagnostics {
	diagnostics: Diagnostic[];
	version: number | null;
}

export interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: Diagnostic[];
	version?: number | null;
}

export interface TextEdit {
	range: Range;
	newText: string;
	insertTextFormat?: 1 | 2;
}

interface AnnotatedTextEdit extends TextEdit {
	annotationId?: string;
}

interface TextDocumentIdentifier {
	uri: string;
}

interface OptionalVersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version?: number | null;
}

export interface TextDocumentEdit {
	textDocument: OptionalVersionedTextDocumentIdentifier;
	edits: (TextEdit | AnnotatedTextEdit)[];
}

export interface CreateFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface CreateFile {
	kind: "create";
	uri: string;
	options?: CreateFileOptions;
}

export interface RenameFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface RenameFile {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: RenameFileOptions;
}

export interface DeleteFileOptions {
	recursive?: boolean;
	ignoreIfNotExists?: boolean;
}

export interface DeleteFile {
	kind: "delete";
	uri: string;
	options?: DeleteFileOptions;
}

type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: DocumentChange[];
	changeAnnotations?: Record<string, { label: string; needsConfirmation?: boolean; description?: string }>;
}

type CodeActionKind =
	| "quickfix"
	| "refactor"
	| "refactor.extract"
	| "refactor.inline"
	| "refactor.rewrite"
	| "source"
	| "source.organizeImports"
	| "source.fixAll"
	| string;

export interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

export interface CodeAction {
	title: string;
	kind?: CodeActionKind;
	diagnostics?: Diagnostic[];
	isPreferred?: boolean;
	disabled?: { reason: string };
	edit?: WorkspaceEdit;
	command?: Command;
	data?: unknown;
}

export interface CodeActionContext {
	diagnostics: Diagnostic[];
	only?: CodeActionKind[];
	triggerKind?: 1 | 2;
}

export type SymbolKind =
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11
	| 12
	| 13
	| 14
	| 15
	| 16
	| 17
	| 18
	| 19
	| 20
	| 21
	| 22
	| 23
	| 24
	| 25
	| 26;

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	location: Location;
	containerName?: string;
}

interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

type MarkedString = string | { language: string; value: string };

export interface Hover {
	contents: MarkupContent | MarkedString | MarkedString[];
	range?: Range;
}

export interface LinterClient {
	format(filePath: string, content: string): Promise<string>;

	lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]>;

	dispose?(): void;
}

type LinterClientFactory = (config: ServerConfig, cwd: string) => LinterClient;

interface ServerCapabilities {
	flycheck?: boolean;
	ssr?: boolean;
	expandMacro?: boolean;
	runnables?: boolean;
	relatedTests?: boolean;
}

export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];

	languageId?: string;
	rootMarkers: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	disabled?: boolean;

	warmupTimeoutMs?: number;

	workspaceReadyTimings?: {
		timeoutMs?: number;
		pollMs?: number;
		settleMs?: number;
		statusRequestTimeoutMs?: number;
	};
	capabilities?: ServerCapabilities;

	isLinter?: boolean;

	resolvedCommand?: string;

	createClient?: LinterClientFactory;
}

export interface LspWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | void | Promise<number | void>;
}

export interface LspTransport {
	readonly stdin: LspWriteSink;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	readonly pid?: number;

	readonly sharedMux?: boolean;
	kill(): void;
	peekStderr(): string;
}

export interface OpenFile {
	version: number;
	languageId: string;
}

export interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	method: string;
}

interface LspServerCapabilities {
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { resolveProvider?: boolean };
	hoverProvider?: boolean;
	definitionProvider?: boolean;
	referencesProvider?: boolean;
	documentSymbolProvider?: boolean;
	workspaceSymbolProvider?: boolean;
	diagnosticProvider?: boolean | Record<string, unknown>;
	[key: string]: unknown;
}

export interface LspClient {
	name: string;
	cwd: string;
	config: ServerConfig;
	proc: LspTransport;
	requestId: number;
	diagnostics: Map<string, PublishedDiagnostics>;
	diagnosticsVersion: number;

	dynamicCapabilityRegistrations?: Map<string, string>;
	openFiles: Map<string, OpenFile>;
	pendingRequests: Map<number | string, PendingRequest>;
	messageBuffer: Uint8Array;
	isReading: boolean;

	status: "connecting" | "ready" | "error";
	serverCapabilities?: LspServerCapabilities;
	lastActivity: number;

	writeQueue: Promise<void>;

	activeProgressTokens: Set<string | number>;

	projectLoaded: Promise<void>;

	resolveProjectLoaded: () => void;
}

export type LspJsonRpcId = number | string;

export interface LspJsonRpcRequest {
	jsonrpc: "2.0";
	id: LspJsonRpcId;
	method: string;
	params: unknown;
}

export interface LspJsonRpcResponse {
	jsonrpc: "2.0";
	id?: LspJsonRpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface LspJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}
