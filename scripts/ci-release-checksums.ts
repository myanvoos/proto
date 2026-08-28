#!/usr/bin/env bun

import * as path from "node:path";

export interface ChecksumEntry {
	name: string;
	sha256: string;
}

export function formatChecksums(entries: readonly ChecksumEntry[]): string {
	return entries
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(({ sha256, name }) => `${sha256}  ${name}\n`)
		.join("");
}

async function main(): Promise<void> {
	const [outFile, ...assetPaths] = process.argv.slice(2);
	if (!outFile || assetPaths.length === 0) {
		throw new Error("usage: ci-release-checksums.ts <out-file> <asset>...");
	}

	const entries = await Promise.all(
		assetPaths.map(async assetPath => {
			const hasher = new Bun.CryptoHasher("sha256");
			for await (const chunk of Bun.file(assetPath).stream()) {
				hasher.update(chunk);
			}
			return { name: path.basename(assetPath), sha256: hasher.digest("hex") };
		}),
	);

	await Bun.write(outFile, formatChecksums(entries));
	console.log(`Wrote ${entries.length} checksum(s) to ${outFile}`);
}

if (import.meta.main) {
	await main();
}
