/** Graph payload is base64 text; envelopes and module metadata have separate framing headroom. */
export const MAX_GRAPH_PAYLOAD_CHARS = 64 * 1024 * 1024;
export const MAX_GRAPH_FRAME_CHARS = 96 * 1024 * 1024;
