import { ArchiveError } from "./error";

export const UTF8_DECODER = new TextDecoder();

export function readUInt16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

export function readUInt32LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

export function readUInt64LE(bytes: Uint8Array, offset: number): number {
	const value = readUInt32LE(bytes, offset) + readUInt32LE(bytes, offset + 4) * 0x100000000;
	if (!Number.isSafeInteger(value)) {
		throw new ArchiveError("Archive uses offsets or sizes too large to read safely");
	}
	return value;
}

export function readUInt16BE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

export function readUInt32BE(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

export function writeUInt16LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
}

export function writeUInt32LE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = value & 0xff;
	buf[offset + 1] = (value >>> 8) & 0xff;
	buf[offset + 2] = (value >>> 16) & 0xff;
	buf[offset + 3] = (value >>> 24) & 0xff;
}

export function writeUInt64LE(buf: Uint8Array, offset: number, value: number): void {
	writeUInt32LE(buf, offset, value >>> 0);
	writeUInt32LE(buf, offset + 4, Math.floor(value / 0x100000000));
}

export function bytesMatchAscii(bytes: Uint8Array, offset: number, value: string): boolean {
	if (bytes.byteLength < offset + value.length) return false;
	for (let index = 0; index < value.length; index++) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false;
	}
	return true;
}

export function bytesEqualAscii(bytes: Uint8Array, value: string): boolean {
	return bytes.byteLength === value.length && bytesMatchAscii(bytes, 0, value);
}

export function indexOfAscii(bytes: Uint8Array, value: string, start: number): number {
	for (let offset = start; offset <= bytes.byteLength - value.length; offset++) {
		if (bytesMatchAscii(bytes, offset, value)) return offset;
	}
	return -1;
}
