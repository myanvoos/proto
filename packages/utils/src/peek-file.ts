import * as fs from "node:fs";

const INITIAL_SYNC_BUFFER_SIZE = 1024;
const EMPTY_BUFFER = new Uint8Array(0);

let syncPool = new Uint8Array(INITIAL_SYNC_BUFFER_SIZE);

// Async peeks get a fresh window so a slice the callback retains cannot be overwritten by a later read. A plain view
// keeps Uint8Array.slice copy semantics (Buffer.slice would alias) without zeroing bytes the read replaces.
function allocateWindow(length: number): Uint8Array {
	const buffer = Buffer.allocUnsafe(length);
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function withSyncPoolBuffer<T>(maxBytes: number, op: (buffer: Uint8Array) => T): T {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}
	if (maxBytes > syncPool.byteLength) {
		syncPool = new Uint8Array(maxBytes + (maxBytes >> 1));
	}
	return op(syncPool.subarray(0, maxBytes));
}

export function peekFileSync<T>(filePath: string, maxBytes: number, op: (header: Uint8Array) => T): T {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = fs.openSync(filePath, "r");
	try {
		return withSyncPoolBuffer(maxBytes, buffer => {
			const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.byteLength, 0);
			return op(buffer.subarray(0, bytesRead));
		});
	} finally {
		fs.closeSync(fileHandle);
	}
}

export async function peekFile<T>(filePath: string, maxBytes: number, op: (header: Uint8Array) => T): Promise<T> {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = await fs.promises.open(filePath, "r");
	try {
		const buffer = allocateWindow(maxBytes);
		const { bytesRead } = await fileHandle.read(buffer, 0, buffer.byteLength, 0);
		return op(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

export async function peekFileTail<T>(filePath: string, maxBytes: number, op: (tail: Uint8Array) => T): Promise<T> {
	if (maxBytes <= 0) {
		return op(EMPTY_BUFFER);
	}

	const fileHandle = await fs.promises.open(filePath, "r");
	try {
		const { size } = await fileHandle.stat();
		const len = Math.min(maxBytes, size);
		if (len <= 0) {
			return op(EMPTY_BUFFER);
		}
		const buffer = allocateWindow(len);
		const { bytesRead } = await fileHandle.read(buffer, 0, buffer.byteLength, size - len);
		return op(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

export async function peekFileEnds<T>(
	filePath: string,
	prefixBytes: number,
	suffixBytes: number,
	op: (head: Uint8Array, tail: Uint8Array) => T,
): Promise<T> {
	if (prefixBytes <= 0 && suffixBytes <= 0) {
		return op(EMPTY_BUFFER, EMPTY_BUFFER);
	}

	const fileHandle = await fs.promises.open(filePath, "r");
	try {
		const { size } = await fileHandle.stat();
		const headLen = prefixBytes > 0 ? Math.min(prefixBytes, size) : 0;
		const tailLen = suffixBytes > 0 ? Math.min(suffixBytes, size) : 0;

		const head = headLen > 0 ? allocateWindow(headLen) : EMPTY_BUFFER;
		const headBytesRead = headLen > 0 ? (await fileHandle.read(head, 0, head.byteLength, 0)).bytesRead : 0;
		const headSlice = head.subarray(0, headBytesRead);

		if (tailLen <= 0) {
			return op(headSlice, EMPTY_BUFFER);
		}
		if (size <= headLen) {
			return op(headSlice, headSlice.subarray(Math.max(0, headBytesRead - tailLen)));
		}

		const tail = allocateWindow(tailLen);
		const { bytesRead: tailBytesRead } = await fileHandle.read(tail, 0, tail.byteLength, size - tailLen);
		return op(headSlice, tail.subarray(0, tailBytesRead));
	} finally {
		await fileHandle.close();
	}
}
