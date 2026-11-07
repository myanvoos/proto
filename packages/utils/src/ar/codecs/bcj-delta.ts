export function deltaDecode(bytes: Uint8Array, distance: number): void {
	const history = new Uint8Array(256);
	let position = 0;
	for (let index = 0; index < bytes.byteLength; index++) {
		const value = (bytes[index]! + history[(distance + position) & 0xff]!) & 0xff;
		history[position] = value;
		bytes[index] = value;
		position = (position - 1) & 0xff;
	}
}

export function x86Decode(bytes: Uint8Array, startOffset: number): void {
	const maskToBitNumber = [0, 1, 2, 2, 3] as const;
	let previousMask = 0;
	let previousPosition = 0xfffffffb;
	if (bytes.byteLength < 5) return;
	let position = 0;
	const limit = bytes.byteLength - 5;
	while (position <= limit) {
		let byte = bytes[position]!;
		if (byte !== 0xe8 && byte !== 0xe9) {
			position++;
			continue;
		}
		const absolutePosition = (startOffset + position) >>> 0;
		const offset = (absolutePosition - previousPosition) >>> 0;
		previousPosition = absolutePosition;
		if (offset > 5) previousMask = 0;
		else for (let index = 0; index < offset; index++) previousMask = ((previousMask & 0x77) << 1) >>> 0;
		byte = bytes[position + 4]!;
		if ((byte === 0 || byte === 0xff) && previousMask >>> 1 <= 4 && previousMask >>> 1 !== 3) {
			let source =
				(bytes[position + 1]! |
					(bytes[position + 2]! << 8) |
					(bytes[position + 3]! << 16) |
					(bytes[position + 4]! << 24)) >>>
				0;
			let destination = 0;
			for (;;) {
				destination = (source - absolutePosition - 5) >>> 0;
				if (previousMask === 0) break;
				const bitIndex = maskToBitNumber[previousMask >>> 1]! * 8;
				const testByte = (destination >>> (24 - bitIndex)) & 0xff;
				if (testByte !== 0 && testByte !== 0xff) break;
				const lowMask = bitIndex === 0 ? 0xffffffff : 2 ** (32 - bitIndex) - 1;
				source = (destination ^ lowMask) >>> 0;
			}
			bytes[position + 4] = ~(((destination >>> 24) & 1) - 1) & 0xff;
			bytes[position + 3] = destination >>> 16;
			bytes[position + 2] = destination >>> 8;
			bytes[position + 1] = destination;
			position += 5;
			previousMask = 0;
		} else {
			position++;
			previousMask |= 1;
			if (byte === 0 || byte === 0xff) previousMask |= 0x10;
		}
	}
}
