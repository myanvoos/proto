import {
	type ClipboardImage,
	copyToClipboard as nativeCopyToClipboard,
	readImageFromClipboard as nativeReadImageFromClipboard,
} from "@oh-my-pi/pi-natives/clipboard";
import { EDITOR_LIMITS } from "@oh-my-pi/pi-tui/editor-limits";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils/mime";
import { readBytesWithLimit } from "@oh-my-pi/pi-utils/stream";
import {
	assertImageInputSize,
	ImageResourceLimitError,
	MAX_IMAGE_INPUT_BYTES,
	reserveImageInput,
} from "./image-resources";
import MAC_FILE_URL_SCRIPT from "./mac-file-urls.applescript" with { type: "text" };

type SpawnCaptureOptions = { input?: string; timeoutMs?: number; env?: Record<string, string | undefined> };

async function spawnCapture(cmd: string[], options: SpawnCaptureOptions & { encoding: "bytes" }): Promise<Uint8Array>;
async function spawnCapture(cmd: string[], options?: SpawnCaptureOptions): Promise<string>;
async function spawnCapture(
	cmd: string[],
	options: SpawnCaptureOptions & { encoding?: "bytes" } = {},
): Promise<string | Uint8Array> {
	const timeoutMs = options.timeoutMs ?? 2000;
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "ignore",
		stdin: options.input !== undefined ? Buffer.from(options.input) : "ignore",
		...(options.env ? { env: options.env } : {}),
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const maxBytes = options.encoding === "bytes" ? MAX_IMAGE_INPUT_BYTES : EDITOR_LIMITS.draftBytes;
		const { bytes, truncated } = await readBytesWithLimit(proc.stdout, maxBytes);
		if (truncated) {
			proc.kill();
			await proc.exited;
			throw new RangeError(`Clipboard exceeds ${maxBytes} bytes and was not pasted`);
		}
		const stdout = options.encoding === "bytes" ? bytes : new TextDecoder().decode(bytes);
		await proc.exited;
		if (timedOut) {
			throw new Error(`${cmd[0]} timed out after ${timeoutMs}ms`);
		}
		if (proc.exitCode !== 0) {
			throw new Error(`${cmd[0]} exited with code ${proc.exitCode}`);
		}
		return stdout;
	} finally {
		clearTimeout(timer);
	}
}

function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// pbcopy(1) sniffs leading bytes and stores PDF, EPS, or RTF headers as that document type instead of text.
function isPasteboardTypedByHeader(text: string): boolean {
	return text.startsWith("%PDF-") || text.startsWith("%!PS") || text.startsWith("{\\rtf");
}

export async function readMacFileUrlsFromClipboard(): Promise<string[]> {
	if (process.platform !== "darwin") return [];
	try {
		const stdout = await spawnCapture(["osascript", "-"], { input: MAC_FILE_URL_SCRIPT });
		return stdout
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch (error) {
		logger.warn("clipboard: failed to read macOS file URLs", { error: String(error) });
		return [];
	}
}

let macClipboardWrite = Promise.resolve();

export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
		const onError = (err: unknown) => {
			process.stdout.off("error", onError);

			if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
				return;
			}
		};
		try {
			const encoded = Buffer.from(text).toString("base64");
			const osc52 = `\x1b]52;c;${encoded}\x07`;
			process.stdout.on("error", onError);
			process.stdout.write(osc52, err => {
				process.stdout.off("error", onError);

				if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
					return;
				}
			});
		} catch (err) {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
			}
		}
	}

	// Keep pbcopy and native fallback writes in invocation order.
	let releaseWrite: (() => void) | undefined;
	if (process.platform === "darwin") {
		const previousWrite = macClipboardWrite;
		const { promise, resolve } = Promise.withResolvers<void>();
		macClipboardWrite = promise;
		releaseWrite = resolve;
		await previousWrite;
	}

	try {
		if (process.env.TERMUX_VERSION) {
			try {
				await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
				return;
			} catch {}
		}
		// The in-process AppKit write logs `NSPasteboard ... returns false` to the terminal's stderr when it
		// loses pasteboard ownership (e.g. at exit); a pbcopy child cannot. pbcopy decodes stdin per LANG,
		// so force UTF-8 to keep non-ASCII text intact.
		if (process.platform === "darwin" && !isPasteboardTypedByHeader(text)) {
			try {
				await spawnCapture(["pbcopy"], {
					input: text,
					timeoutMs: 5000,
					env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
				});
				return;
			} catch {}
		}

		await nativeCopyToClipboard(text);
	} catch {
	} finally {
		releaseWrite?.();
	}
}

async function readTextFromX11Clipboard(): Promise<string> {
	try {
		return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
	} catch (error) {
		if (error instanceof RangeError) throw error;
		return await spawnCapture(["xsel", "--clipboard", "--output"]);
	}
}

export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
	// The platform clipboard API cannot inspect size before allocation. Reserve its
	// maximum admitted payload up front and keep the lease until the native read settles.
	const lease = reserveImageInput(MAX_IMAGE_INPUT_BYTES);
	try {
		return await readClipboardImage();
	} finally {
		lease.release();
	}
}

async function readClipboardImage(): Promise<ClipboardImage | null> {
	if (process.env.TERMUX_VERSION) {
		return null;
	}

	if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
		try {
			const offeredMimeTypes = new Set((await spawnCapture(["wl-paste", "--list-types"])).split(/\r?\n/));
			for (const mimeType of SUPPORTED_IMAGE_MIME_TYPES) {
				if (!offeredMimeTypes.has(mimeType)) continue;
				const data = await spawnCapture(["wl-paste", "--type", mimeType], { encoding: "bytes" });
				if (data.byteLength > 0) return { data, mimeType };
			}
		} catch (error) {
			if (error instanceof RangeError) throw error;
		}
	}

	if (!hasDisplay()) {
		return null;
	}

	try {
		const image = await nativeReadImageFromClipboard();
		if (image) assertImageInputSize(image.data.byteLength);
		return image ?? null;
	} catch (error) {
		if (error instanceof ImageResourceLimitError) throw error;
		logger.warn("clipboard: failed to read clipboard image", { error: String(error) });
		return null;
	}
}

export async function readTextFromClipboard(): Promise<string> {
	try {
		const p = process.platform;
		if (p === "darwin") {
			return await spawnCapture(["pbpaste"]);
		}
		if (process.env.TERMUX_VERSION) {
			return await spawnCapture(["termux-clipboard-get"]);
		}
		const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
		const hasX11Display = Boolean(process.env.DISPLAY);
		if (hasWaylandDisplay) {
			try {
				return await spawnCapture(["wl-paste", "--type", "text", "--no-newline"]);
			} catch (error) {
				if (error instanceof RangeError) throw error;
				if (hasX11Display) {
					return await readTextFromX11Clipboard();
				}
			}
		} else if (hasX11Display) {
			return await readTextFromX11Clipboard();
		}
	} catch (error) {
		if (error instanceof RangeError) throw error;
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}
