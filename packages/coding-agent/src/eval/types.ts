export type EvalLanguage = "python" | "js";

import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { OutputMeta } from "../tools/output-meta";

export interface EvalStatusEvent {
	op: string;
	[key: string]: unknown;
}

export type EvalDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "markdown"; text?: string }
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
	statusEvents?: EvalStatusEvent[];
	hasMarkdown?: boolean;
}

export interface EvalToolDetails {
	cells?: EvalCellResult[];
	jsonOutputs?: unknown[];
	images?: ImageContent[];
	statusEvents?: EvalStatusEvent[];
	isError?: boolean;
	meta?: OutputMeta;

	language?: EvalLanguage;

	languages?: EvalLanguage[];

	notice?: string;

	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "eval";
	};
}
