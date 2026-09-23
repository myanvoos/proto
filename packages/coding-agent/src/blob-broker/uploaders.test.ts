import { expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import type { BlobUploader } from "./publication";
import { createCommandUploader, memoizeUploader } from "./uploaders";

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

test("command uploads fail instead of running elsewhere when the project directory becomes inaccessible", async () => {
	const projectDir = getProjectDir();
	const accessSync = fs.accessSync;
	const access = vi.spyOn(fs, "accessSync").mockImplementation((target, mode) => {
		if (target === projectDir) throw Object.assign(new Error("operation not permitted"), { code: "EACCES" });
		return accessSync(target, mode);
	});
	const uploader = createCommandUploader(
		`${process.execPath} -e "console.log('https://files.example/' + process.cwd())" {file}`,
	);
	try {
		await expect(
			uploader.upload({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", extension: "png" }),
		).rejects.toThrow(`Project directory is not accessible: ${projectDir}`);
	} finally {
		access.mockRestore();
	}
});
