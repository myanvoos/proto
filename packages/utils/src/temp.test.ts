import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { removeWithRetries, TempDir } from "./temp";

const cleanupPaths = new Set<string>();

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(Array.from(cleanupPaths, target => fsPromises.rm(target, { recursive: true, force: true })));
	cleanupPaths.clear();
});

describe("TempDir cleanup", () => {
	it("allows cleanup to be retried after a transient removal failure", async () => {
		const temp = await TempDir.create("@proto-temp-retry-");
		cleanupPaths.add(temp.path());
		const transientError = Object.assign(new Error("directory is busy"), { code: "EBUSY" });
		const rm = spyOn(fsPromises, "rm").mockRejectedValueOnce(transientError).mockResolvedValueOnce(undefined);

		await expect(temp.remove()).rejects.toBe(transientError);
		await expect(temp.remove()).resolves.toBeUndefined();
		await expect(temp.remove()).resolves.toBeUndefined();
		expect(rm).toHaveBeenCalledTimes(2);
	});

	it("enables the filesystem retry policy for recursive removal", async () => {
		const rm = spyOn(fsPromises, "rm").mockResolvedValue(undefined);

		await removeWithRetries("/unused/test-path");

		expect(rm).toHaveBeenCalledWith("/unused/test-path", {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	});
});
