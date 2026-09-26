export type EvalLanguage = "python" | "js";

import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ExecutionMetadata } from "../session/execution-metadata";
import type { OutputMeta } from "../tools/output-meta";

/** Interpreter-visible command identity, independent of the retained runner process. */
export interface KernelInvocation {
	argv: string[];
	filename?: string;
}

export interface EvalStatusEvent {
	op: string;
	[key: string]: unknown;
}

export type EvalDisplayOutput =
	| { type: "text"; text: string }
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown"; text: string }
	| { type: "notice"; text: string }
	| { type: "status"; event: EvalStatusEvent };

export interface EvalCellResult {
	index: number;
	title?: string;
	code: string;
	language?: EvalLanguage;
	output: string;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	exitCode?: number;
	execution?: ExecutionMetadata;
	statusEvents?: EvalStatusEvent[];
	hasMarkdown?: boolean;
}

export interface EvalToolDetails {
	cells?: EvalCellResult[];
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	statusEvents?: EvalStatusEvent[];
	isError?: boolean;
	execution?: ExecutionMetadata;
	meta?: OutputMeta;

	language?: EvalLanguage;

	languages?: EvalLanguage[];

	notice?: string;

	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}
