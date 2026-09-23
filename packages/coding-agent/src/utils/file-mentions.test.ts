import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FileMentionMessage } from "../session/messages";
import { generateFileMentionMessages } from "./file-mentions";

const ENTRY_COUNT = 2_000;
const EXPECTED_COUNT = 500;

function entryName(index: number): string {
	return `entry-${index.toString().padStart(4, "0")}.txt`;
}

describe("directory file mentions", () => {
	test("retains only the lexicographically first 500 entries while scanning an unordered directory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-file-mentions-"));
		const expectedNames = Array.from({ length: EXPECTED_COUNT }, (_, index) => entryName(index));
		await Promise.all(expectedNames.map(name => Bun.write(path.join(directory, name), "")));

		let yieldedEntryCount = 0;
		async function* unorderedEntries(): AsyncGenerator<string> {
			for (let index = 0; index < ENTRY_COUNT; index++) {
				yieldedEntryCount++;
				yield entryName((index * 1_543 + 997) % ENTRY_COUNT);
			}
		}

		let firstRankAt: number | undefined;
		const originalToLowerCase = String.prototype.toLowerCase;
		const lowercaseSpy = spyOn(String.prototype, "toLowerCase").mockImplementation(function (this: string): string {
			const value = originalToLowerCase.call(this);
			if (firstRankAt === undefined && value.startsWith("entry-")) firstRankAt = yieldedEntryCount;
			return value;
		});
		const scanSpy = spyOn(Bun.Glob.prototype, "scan").mockImplementation(() => unorderedEntries());
		try {
			const messages = await generateFileMentionMessages([directory], directory);
			expect(messages).toHaveLength(1);
			const message = messages[0] as FileMentionMessage;
			expect(message.role).toBe("fileMention");
			const content = message.files[0]?.content ?? "";
			const listing = content.split("\n\n[")[0] ?? "";
			const listedNames = listing.split("\n").map(line => line.replace(/ \([^)]*\)$/, ""));

			expect(listedNames).toEqual(expectedNames);
			expect(content).toContain("[500 entries limit reached.");
			expect(firstRankAt).toBe(1);
		} finally {
			scanSpy.mockRestore();
			lowercaseSpy.mockRestore();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("image file mentions", () => {
	test("a corrupt image is reported as skipped instead of attached", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-file-mentions-image-"));
		try {
			const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			const body = Buffer.alloc(4000);
			for (let i = 0; i < body.length; i++) body[i] = (i * 37 + 11) % 251;
			const corrupt = path.join(directory, "corrupt.png");
			await Bun.write(corrupt, Buffer.concat([signature, body]));

			const messages = await generateFileMentionMessages([corrupt], directory);
			const message = messages[0] as FileMentionMessage;
			const file = message.files[0];

			expect(file?.image).toBeUndefined();
			expect(file?.skippedReason).toBe("undecodableImage");
			expect(file?.content).toContain("corrupt or truncated");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("a decodable image is still attached", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-file-mentions-image-"));
		try {
			const valid = path.join(directory, "valid.png");
			await Bun.write(
				valid,
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
					"base64",
				),
			);

			const messages = await generateFileMentionMessages([valid], directory, { autoResizeImages: false });
			const file = (messages[0] as FileMentionMessage).files[0];

			expect(file?.skippedReason).toBeUndefined();
			expect(file?.image?.mimeType).toBe("image/png");
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
