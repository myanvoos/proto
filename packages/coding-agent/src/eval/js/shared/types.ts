export interface JsStatusEvent {
	op: string;
	[key: string]: unknown;
}

export type JsDisplayOutput =
	| { type: "json"; data: unknown }
	| { type: "image"; data: string; mimeType: string }
	| { type: "status"; event: JsStatusEvent };
