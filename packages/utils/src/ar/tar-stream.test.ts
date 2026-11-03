import { expect, test } from "bun:test";
import { encodeArchive, openArchive } from "./index";

test("compressed tar members larger than the in-memory archive budget remain independently readable", async () => {
	const first = "a".repeat(32_768);
	const second = "b".repeat(16_384);
	const bytes = await encodeArchive("tar.gz", [
		["first.txt", first],
		["second.txt", second],
	]);
	const archive = await openArchive({ bytes, format: "tar.gz" }, { limits: { maxInMemorySize: 4096 } });
	const held = (await archive.readFile("second.txt")).bytes;
	expect(new TextDecoder().decode((await archive.readFile("first.txt")).bytes)).toBe(first);
	expect(new TextDecoder().decode(held)).toBe(second);
	await expect(
		openArchive({ bytes, format: "tar.gz" }, { limits: { maxInMemorySize: 4096, maxStreamSize: 8192 } }),
	).rejects.toThrow();
});

test("plain tar indexes payloads lazily without reading member bytes", async () => {
	const payload = "data".repeat(8192);
	const bytes = await encodeArchive("tar", [["payload.txt", payload]]);
	const ranges: Array<[number, number]> = [];
	const source = {
		size: bytes.length,
		async read(start: number, end: number) {
			ranges.push([start, end]);
			return bytes.slice(start, end);
		},
	};
	const archive = await openArchive({ source, format: "tar" }, { limits: { maxInMemorySize: 1024 } });
	expect(ranges.every(([start, end]) => end - start <= 512)).toBe(true);
	expect(new TextDecoder().decode((await archive.readFile("payload.txt")).bytes)).toBe(payload);
});
