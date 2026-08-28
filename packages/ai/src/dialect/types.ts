import type { Dialect as CatalogDialect } from "@oh-my-pi/pi-catalog/identity";
import type { Context, Message, ToolCall } from "../types";

export type { Dialect } from "@oh-my-pi/pi-catalog/identity";

export type InbandScanEvent =
	| { type: "text"; text: string }
	| { type: "thinkingStart" }
	| { type: "thinkingDelta"; delta: string }
	| { type: "thinkingEnd"; thinking: string }
	| { type: "toolStart"; id: string; name: string }
	| { type: "toolArgDelta"; id: string; name: string; key: string; delta: string }
	| { type: "toolEnd"; id: string; name: string; arguments: Record<string, unknown>; rawBlock?: string };

export interface InbandScanner {
	feed(text: string): InbandScanEvent[];
	flush(): InbandScanEvent[];
}

export interface DialectToolResult {
	readonly id: string;
	readonly name: string;
	readonly index: number;
	readonly text: string;
	readonly isError: boolean;
}

export interface DialectRenderOptions {
	readonly tools?: readonly InbandTool[];
}

export interface DialectDefinition {
	readonly dialect: CatalogDialect;
	readonly prompt: string;
	createScanner(options?: InbandScannerOptions): InbandScanner;

	renderToolCall(call: ToolCall, options?: DialectRenderOptions): string;

	renderAssistantToolCalls(calls: readonly ToolCall[], options?: DialectRenderOptions): string;
	renderToolResults(results: readonly DialectToolResult[], options?: DialectRenderOptions): string;
	renderThinking(text: string): string;
	renderTranscript(messages: readonly Message[], options?: DialectRenderOptions): string;
}

export interface InbandScannerOptions {
	stringArgs?: (toolName: string) => ReadonlySet<string>;

	tools?: readonly InbandTool[];

	xmlTagset?: "anthropic" | "dsml";

	parseThinking?: boolean;
}

export type InbandTool = NonNullable<Context["tools"]>[number];
