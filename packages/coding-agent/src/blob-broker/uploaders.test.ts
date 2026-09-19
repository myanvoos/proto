import { expect, test } from "bun:test";
import type { BlobUploader } from "./publication";
import { memoizeUploader } from "./uploaders";

test("uploader memoization evicts old successful publications", async () => {
	let uploads = 0;
	const uploader: BlobUploader = {
		destination: "command",
		upload: async request => {
			uploads++;
			return {
				url: `https://uploads.test/${uploads}`,
				destination: "command",
				bytes: request.bytes.byteLength,
			};
		},
	};
	const memoized = memoizeUploader(uploader);
	const total = 257;
	for (let index = 0; index < total; index++) {
		await memoized(`hash-${index}`, { bytes: new Uint8Array([index]), mimeType: "image/png", extension: "png" });
	}

	expect(uploads).toBe(total);
	await memoized("hash-0", { bytes: new Uint8Array([0]), mimeType: "image/png", extension: "png" });
	expect(uploads).toBe(total + 1);
});
