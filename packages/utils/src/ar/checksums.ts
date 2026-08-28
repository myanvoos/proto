export function crc32(bytes: Uint8Array, seed = 0): number {
	return Bun.hash.crc32(bytes, seed) >>> 0;
}

const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
	let lo = index;
	let hi = 0;
	for (let bit = 0; bit < 8; bit++) {
		const carry = (lo & 1) !== 0;
		lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
		hi >>>= 1;
		if (carry) {
			lo = (lo ^ 0xd7870f42) >>> 0;
			hi = (hi ^ 0xc96c5795) >>> 0;
		}
	}
	CRC64_LO[index] = lo;
	CRC64_HI[index] = hi;
}

export function crc64(bytes: Uint8Array, seed = 0n): bigint {
	const initial = seed ^ 0xffffffffffffffffn;
	let lo = Number(initial & 0xffffffffn) >>> 0;
	let hi = Number((initial >> 32n) & 0xffffffffn) >>> 0;
	for (let index = 0; index < bytes.length; index++) {
		const slot = (lo ^ bytes[index]!) & 0xff;
		const nextLo = ((lo >>> 8) | ((hi & 0xff) << 24)) >>> 0;
		lo = (nextLo ^ CRC64_LO[slot]!) >>> 0;
		hi = ((hi >>> 8) ^ CRC64_HI[slot]!) >>> 0;
	}
	return ((BigInt(hi) << 32n) | BigInt(lo)) ^ 0xffffffffffffffffn;
}

const CRC16_TABLE = new Uint16Array(256);
for (let index = 0; index < 256; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? (value >>> 1) ^ 0xa001 : value >>> 1;
	CRC16_TABLE[index] = value;
}

export function crc16Arc(bytes: Uint8Array, seed = 0): number {
	let value = seed;
	for (let index = 0; index < bytes.length; index++) {
		value = ((value >>> 8) ^ CRC16_TABLE[(value ^ bytes[index]!) & 0xff]!) & 0xffff;
	}
	return value;
}
