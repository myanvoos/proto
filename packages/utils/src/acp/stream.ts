import { type AnyMessage, malformedMessage } from "./transport";

export interface Stream {
	writable: WritableStream<AnyMessage>;
	readable: ReadableStream<AnyMessage>;
}

export function ndJsonStream(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>): Stream {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const writable = new WritableStream<AnyMessage>({
		async write(message) {
			const writer = output.getWriter();
			try {
				await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
			} finally {
				writer.releaseLock();
			}
		},
		async close() {
			const writer = output.getWriter();
			try {
				await writer.close();
			} finally {
				writer.releaseLock();
			}
		},
		async abort(reason) {
			const writer = output.getWriter();
			try {
				await writer.abort(reason);
			} finally {
				writer.releaseLock();
			}
		},
	});
	let buffered = "";
	const readable = new ReadableStream<AnyMessage>({
		async start(controller) {
			const reader = input.getReader();
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					buffered += decoder.decode(next.value, { stream: true });
					let newline = buffered.indexOf("\n");
					while (newline >= 0) {
						const line = buffered.slice(0, newline).trimEnd();
						buffered = buffered.slice(newline + 1);
						if (line.length > 0) controller.enqueue(parseMessage(line));
						newline = buffered.indexOf("\n");
					}
				}
				buffered += decoder.decode();
				const finalLine = buffered.trim();
				if (finalLine.length > 0) controller.enqueue(parseMessage(finalLine));
				controller.close();
			} catch (error) {
				controller.error(error);
			} finally {
				reader.releaseLock();
			}
		},
	});
	return { writable, readable };
}

function parseMessage(line: string): AnyMessage {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		return malformedMessage({
			code: -32700,
			message: "Parse error",
			details: error instanceof Error ? error.message : String(error),
		});
	}
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("jsonrpc" in value)) {
		return malformedMessage({ code: -32600, message: "Invalid request", details: "not a JSON-RPC 2.0 object" });
	}
	if (value.jsonrpc !== "2.0") {
		return malformedMessage({
			code: -32600,
			message: "Invalid request",
			details: `unsupported jsonrpc version: ${JSON.stringify(value.jsonrpc)}`,
			// An otherwise well-formed request still deserves its id back.
			id: readJsonRpcId(value),
		});
	}
	return value as AnyMessage;
}

function readJsonRpcId(value: object): string | number | undefined {
	if (!("id" in value)) return undefined;
	const id = (value as { id: unknown }).id;
	return typeof id === "string" || typeof id === "number" ? id : undefined;
}
