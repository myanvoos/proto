import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getToolsDir } from "@oh-my-pi/pi-utils";
import { ensureTool } from "./tools-manager";

const releaseDownload = Promise.withResolvers<void>();
const firstChunkWritten = Promise.withResolvers<void>();
let metadataRequests = 0;
let assetRequests = 0;
let phase: "streaming" | "empty" = "streaming";

const binaryPrefix = new TextEncoder().encode("#!/bin/sh\n");
const binarySuffix = new TextEncoder().encode("exit 0\n");

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("/releases/latest")) {
			metadataRequests++;
			return Response.json({ tag_name: "2026.09.19" });
		}
		assetRequests++;
		if (phase === "empty") return new Response(new Uint8Array());
		let sentPrefix = false;
		return new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						if (!sentPrefix) {
							sentPrefix = true;
							controller.enqueue(binaryPrefix);
							return;
						}
						firstChunkWritten.resolve();
						return releaseDownload.promise.then(() => {
							controller.enqueue(binarySuffix);
							controller.close();
						});
					},
				},
				{ highWaterMark: 0 },
			),
		);
	},
	{ preconnect: originalFetch.preconnect },
);

const first = ensureTool("yt-dlp", { silent: true });
const second = ensureTool("yt-dlp", { silent: true });
await firstChunkWritten.promise;

const binaryPath = path.join(getToolsDir(), "yt-dlp");
const visibleDuringDownload = await Bun.file(binaryPath).exists();
releaseDownload.resolve();
const installedPaths = await Promise.all([first, second]);
const installedContent = await Bun.file(binaryPath).text();
const streamingCounts = { metadataRequests, assetRequests };

await fs.rm(binaryPath, { force: true });
phase = "empty";
const emptyResult = await ensureTool("yt-dlp", { silent: true });
const emptyFinalExists = await Bun.file(binaryPath).exists();

process.stdout.write(
	`${JSON.stringify({
		visibleDuringDownload,
		installedPaths,
		installedContent,
		streamingCounts,
		emptyResult,
		emptyFinalExists,
	})}\n`,
);
