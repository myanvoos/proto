import {
	type ClipboardImage,
	copyToClipboard as nativeCopyToClipboard,
	readImageFromClipboard as nativeReadImageFromClipboard,
} from "@oh-my-pi/pi-natives/clipboard";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { SUPPORTED_IMAGE_MIME_TYPES } from "@oh-my-pi/pi-utils/mime";
import MAC_FILE_URL_SCRIPT from "./mac-file-urls.applescript" with { type: "text" };

type SpawnCaptureOptions = { input?: string; timeoutMs?: number };

/**
 * Run a subprocess and capture its stdout without blocking the event loop.
 *
 * `readTextFromClipboard`, `readMacFileUrlsFromClipboard`, and the Termux copy
 * path all shell out to CLI clipboard tools. The synchronous `execSync` API
 * parks the render loop until the child exits or the timeout fires, so a hung
 * clipboard daemon freezes the TUI for the full 2000ms budget (#4235). This
 * helper mirrors the previous semantics — capture stdout, throw on non-zero
 * exit or timeout, forward optional stdin — but yields to the event loop while
 * the child runs.
 *
 * @throws Error when the child fails to spawn, is killed by the timeout, or
 *   exits with a non-zero status. Callers rely on this to use platform
 *   fallbacks or report an empty clipboard.
 */
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
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	try {
		const response = new Response(proc.stdout);
		const stdout =
			options.encoding === "bytes" ? new Uint8Array(await response.arrayBuffer()) : await response.text();
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

/**
 * Read file paths from the macOS pasteboard's `public.file-url` representation.
 *
 * Used to reach the Finder `Cmd+C` pasteboard (which exposes only file URLs,
 * no plain text or raw image bytes) so an image-file clipboard can be attached
 * via {@link handleImagePathPaste} instead of falling through to "Clipboard is
 * empty". Returns an empty array on non-darwin platforms, when AppleScript is
 * unavailable, or when the pasteboard holds no file URLs.
 */
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

/**
 * Copy text to the system clipboard.
 *
 * Emits OSC 52 first when running in a real terminal (works over SSH/mosh),
 * then attempts native clipboard copy as best-effort for local sessions.
 * On Termux, tries `termux-clipboard-set` before native.
 *
 * @param text - UTF-8 text to place on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<void> {
	if (process.stdout.isTTY) {
		const onError = (err: unknown) => {
			process.stdout.off("error", onError);
			// Prevent unhandled 'error' from crashing the process when stdout is a closed pipe.
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
				// If stdout is closed (e.g. piped to a process that exits early),
				// ignore EPIPE and proceed with native clipboard best-effort.
				if ((err as NodeJS.ErrnoException | null | undefined)?.code === "EPIPE") {
					return;
				}
			});
		} catch (err) {
			process.stdout.off("error", onError);
			if ((err as NodeJS.ErrnoException | null | undefined)?.code !== "EPIPE") {
				// Ignore all write failures (OSC 52 is best-effort).
			}
		}
	}

	// Also try native tools (best effort for local sessions)
	try {
		if (process.env.TERMUX_VERSION) {
			try {
				await spawnCapture(["termux-clipboard-set"], { input: text, timeoutMs: 5000 });
				return;
			} catch {
				// Fall through to native
			}
		}

		await nativeCopyToClipboard(text);
	} catch {
		// Ignore — clipboard copy is best-effort
	}
}

async function readTextFromX11Clipboard(): Promise<string> {
	try {
		return await spawnCapture(["xclip", "-selection", "clipboard", "-o"]);
	} catch {
		return await spawnCapture(["xsel", "--clipboard", "--output"]);
	}
}

/**
 * Read an image from the system clipboard.
 *
 * Returns null on Termux (no image clipboard support) or when no display
 * server is available (headless/SSH without forwarding).
 *
 * @returns A supported image payload or null when no image is available.
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
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
		} catch {
			// Fall through when wl-clipboard is absent or no advertised image payload can be read.
		}
	}

	if (!hasDisplay()) {
		return null;
	}

	try {
		return (await nativeReadImageFromClipboard()) ?? null;
	} catch (error) {
		// Some selection owners make the native image read throw instead of
		// reporting "no image" — e.g. an xclip-written text-only selection
		// (arboard: "Unknown error ... incorrect type received from clipboard").
		// Treat a failed image read as "no image" so the caller's smart-paste
		// text fallback still delivers the clipboard content.
		logger.warn("clipboard: failed to read clipboard image", { error: String(error) });
		return null;
	}
}

/**
 * Read plain text from the system clipboard.
 */
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
				return await spawnCapture(["wl-paste", "--type", "text/plain", "--no-newline"]);
			} catch {
				if (hasX11Display) {
					return await readTextFromX11Clipboard();
				}
			}
		} else if (hasX11Display) {
			return await readTextFromX11Clipboard();
		}
	} catch (error) {
		logger.warn("clipboard: failed to read clipboard text", { error: String(error) });
	}
	return "";
}
