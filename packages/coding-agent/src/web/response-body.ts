function charsetFromContentType(header: string): string | undefined {
	return /charset\s*=\s*"?([\w-]+)"?/i.exec(header)?.[1];
}

export function decodeBody(bytes: Uint8Array, contentTypeHeader: string): string {
	let label = charsetFromContentType(contentTypeHeader);
	if (!label && (contentTypeHeader.trim() === "" || /html/i.test(contentTypeHeader))) {
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(
			new TextDecoder("latin1" as Bun.Encoding).decode(bytes.subarray(0, 2048)),
		)?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			return new TextDecoder(label as Bun.Encoding).decode(bytes);
		} catch {}
	}
	return new TextDecoder().decode(bytes);
}

export interface ReadResponseBytesResult {
	bytes: Uint8Array;
	truncated: boolean;
}

/** Read a bounded body with one growing buffer, including for tiny or empty chunks. */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<ReadResponseBytesResult> {
	const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : 50 * 1024 * 1024;
	const reader = response.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), truncated: false };
	let buffer = new Uint8Array(Math.min(limit, 64 * 1024));
	let size = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			const accepted = Math.min(value.byteLength, limit - size);
			if (size + accepted > buffer.byteLength) {
				const grown = new Uint8Array(Math.min(limit, Math.max(size + accepted, buffer.byteLength * 2)));
				grown.set(buffer.subarray(0, size));
				buffer = grown;
			}
			buffer.set(value.subarray(0, accepted), size);
			size += accepted;
			if (accepted < value.byteLength) {
				truncated = true;
				await reader.cancel("response body limit exceeded").catch(() => {});
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return { bytes: buffer.subarray(0, size), truncated };
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string | null> {
	const result = await readResponseBytes(response, maxBytes);
	if (result.truncated) return null;
	return decodeBody(result.bytes, response.headers.get("content-type") ?? "");
}
