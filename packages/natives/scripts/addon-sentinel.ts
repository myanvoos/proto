/**
 * The `__piNativesV…` export name a native addon was compiled with. The loader
 * derives the name it requires from this package's version, so an addon rebuilt
 * after a version bump must expose the matching sentinel; an addon copied from
 * an older build exposes the old one and is rejected at load time.
 */

/** Sentinel the loader will demand for `@oh-my-pi/pi-natives@version`. */
export function expectedAddonSentinel(version: string): string {
	return `__piNativesV${version.replace(/[^A-Za-z0-9]/g, "_")}`;
}

const MARKER = Buffer.from("__piNativesV");

/** The sentinel embedded in a compiled addon, or undefined for a build that predates the marker. */
export function addonSentinel(bytes: Uint8Array): string | undefined {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const at = buffer.indexOf(MARKER);
	if (at < 0) return undefined;
	let end = at + MARKER.length;
	// The exported name continues with `[A-Za-z0-9_]`; anything else ends it.
	while (end < buffer.length) {
		const code = buffer[end]!;
		const nameChar =
			(code >= 0x30 && code <= 0x39) ||
			(code >= 0x41 && code <= 0x5a) ||
			(code >= 0x61 && code <= 0x7a) ||
			code === 0x5f;
		if (!nameChar) break;
		end++;
	}
	return buffer.toString("latin1", at, end);
}

/** Reject an addon whose sentinel does not match the package version it will ship with. */
export function assertAddonSentinel(filename: string, sentinel: string | undefined, version: string): void {
	const expected = expectedAddonSentinel(version);
	if (sentinel === expected) return;
	const found = sentinel === undefined ? "no version sentinel at all" : `the ${sentinel} sentinel`;
	throw new Error(
		`${filename} exposes ${found}, but @oh-my-pi/pi-natives@${version} requires ${expected}. ` +
			"Embedding it would ship an addon this release's own loader rejects. " +
			"Rebuild the addon after the version bump (bun run build:native, or scripts/build-natives.sh <target>).",
	);
}
