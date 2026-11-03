export type Base64ImageDecodeResult =
	| { bytes: Buffer; reason?: never }
	| { bytes?: never; reason: "invalid base64 image data" | "empty image data" };

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode standard base64, accepting omitted padding but only canonical trailing bits. */
export function decodeBase64ImageData(data: string): Base64ImageDecodeResult {
	if (data.length === 0) return { reason: "empty image data" };
	const match = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(data);
	if (!match) return { reason: "invalid base64 image data" };
	const encoded = match[1];
	const paddingLength = match[2].length;
	const remainder = encoded.length % 4;
	if (
		(remainder === 1 && paddingLength === 0) ||
		(paddingLength === 1 && remainder !== 3) ||
		(paddingLength === 2 && remainder !== 2)
	) {
		return { reason: "invalid base64 image data" };
	}
	const lastSextet = BASE64_ALPHABET.indexOf(encoded[encoded.length - 1]);
	if ((remainder === 2 && (lastSextet & 0b1111) !== 0) || (remainder === 3 && (lastSextet & 0b11) !== 0)) {
		return { reason: "invalid base64 image data" };
	}
	const bytes = Buffer.from(data, "base64");
	return bytes.length > 0 ? { bytes } : { reason: "empty image data" };
}
