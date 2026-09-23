import { gunzipSync } from "node:zlib";
import { fromBinary, type MessageCodec, type ProtoMessage } from "../discovery/protobuf";

// Edges return either bare or gzipped protobuf; Bun's fetch usually decompresses first.
export function decodeDevinUnaryMessage<TMessage extends ProtoMessage>(
	schema: MessageCodec<TMessage>,
	payload: Uint8Array,
): TMessage | null {
	try {
		return fromBinary(schema, payload);
	} catch {
		try {
			return fromBinary(schema, gunzipSync(payload));
		} catch {
			return null;
		}
	}
}
