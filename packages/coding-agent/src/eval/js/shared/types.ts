export interface JsStatusEvent {
	op: string;
	[key: string]: unknown;
}

export type JsDisplayOutput =
	| { type: "text"; text: string }
	| { type: "json"; data: unknown }
	| { type: "notice"; text: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "status"; event: JsStatusEvent };
