import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as native from "@oh-my-pi/pi-natives/clipboard";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = { cmd: string[]; options: SpawnOptions };
type SpawnOutput = string | Uint8Array;

function streamOf(body: SpawnOutput): ReadableStream<Uint8Array> {
	const stream = new Response(body).body;
	if (!stream) throw new Error("Failed to create response stream.");
	return stream;
}

function fakeProcess(stdout: SpawnOutput, exitCode = 0): Subprocess {
	return {
		pid: 1,
		stdout: streamOf(stdout),
		stderr: streamOf(""),
		exitCode,
		exited: Promise.resolve(exitCode),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[], stdout: SpawnOutput | SpawnOutput[], exitCode: number | number[] = 0) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		const output = Array.isArray(stdout) ? (stdout[calls.length - 1] ?? "") : stdout;
		const code = Array.isArray(exitCode) ? (exitCode[calls.length - 1] ?? 0) : exitCode;
		return fakeProcess(output, code);
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

const ENV_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "TERMUX_VERSION"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = savedEnv[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	restorePlatform();
	vi.restoreAllMocks();
});

describe("readImageFromClipboard dispatch", () => {
	it("returns null on linux without a display server and never spawns anything", async () => {
		setPlatform("linux");
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).not.toHaveBeenCalled();
	});

	it("delegates straight to the native bridge on linux with a display", async () => {
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard").mockResolvedValue(null);

		await readImageFromClipboard();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).toHaveBeenCalledTimes(1);
	});

	it("treats a throwing native image read as no image on linux with a display", async () => {
		// Regression: an xclip-written text-only selection makes arboard's
		// image read throw ("Unknown error ... incorrect type received from
		// clipboard") instead of reporting no image. readImageFromClipboard
		// must not propagate that — the smart-paste text fallback depends on
		// a null return.
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		vi.spyOn(native, "readImageFromClipboard").mockRejectedValue(
			new Error("Unknown error while interacting with the clipboard: incorrect type received from clipboard"),
		);

		expect(await readImageFromClipboard()).toBeNull();
	});

	it.each(["image/png", "image/jpeg", "image/gif", "image/webp"] as const)(
		"reads %s bytes through wl-paste before the native bridge on Wayland-only Linux",
		async mimeType => {
			setPlatform("linux");
			process.env.WAYLAND_DISPLAY = "wayland-0";
			const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
			const calls: SpawnCall[] = [];
			spySpawn(calls, [`text/plain\n${mimeType}\n`, data]);
			const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

			const image = await readImageFromClipboard();

			expect(calls).toHaveLength(2);
			expect(calls[0]?.cmd).toEqual(["wl-paste", "--list-types"]);
			expect(calls[1]?.cmd).toEqual(["wl-paste", "--type", mimeType]);
			expect(image).toEqual({ data, mimeType });
			expect(nativeSpy).not.toHaveBeenCalled();
		},
	);

	it("returns null on Termux without spawning anything", async () => {
		setPlatform("linux");
		process.env.TERMUX_VERSION = "0.118";
		const spawnSpy = vi.spyOn(Bun, "spawn");
		const nativeSpy = vi.spyOn(native, "readImageFromClipboard");

		expect(await readImageFromClipboard()).toBeNull();
		expect(spawnSpy).not.toHaveBeenCalled();
		expect(nativeSpy).not.toHaveBeenCalled();
	});
});

describe("readMacFileUrlsFromClipboard", () => {
	it("returns an empty list on non-darwin platforms without spawning osascript", async () => {
		setPlatform("linux");
		const spawnSpy = vi.spyOn(Bun, "spawn");

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it("splits osascript output into one path per non-empty line on darwin", async () => {
		setPlatform("darwin");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "/Users/me/Pictures/photo.png\n/Users/me/Pictures/clip.jpg\n\n");

		const paths = await readMacFileUrlsFromClipboard();

		expect(paths).toEqual(["/Users/me/Pictures/photo.png", "/Users/me/Pictures/clip.jpg"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["osascript", "-"]);
		// AppleScript payload is piped as stdin; the fix uses Bun.spawn with a
		// Buffer so the child receives it without blocking the event loop.
		const stdin = calls[0]?.options.stdin;
		expect(Buffer.isBuffer(stdin)).toBe(true);
		expect((stdin as Buffer).toString("utf8")).toContain("«class furl»");
	});

	it("returns an empty list when osascript exits non-zero (e.g. binary missing)", async () => {
		setPlatform("darwin");
		spySpawn([], "", 127);

		expect(await readMacFileUrlsFromClipboard()).toEqual([]);
	});
});

describe("readTextFromClipboard", () => {
	it("falls back to xsel when xclip is unavailable on X11", async () => {
		setPlatform("linux");
		process.env.DISPLAY = ":0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, ["", "from xsel"], [1, 0]);

		expect(await readTextFromClipboard()).toBe("from xsel");
		expect(calls.map(call => call.cmd)).toEqual([
			["xclip", "-selection", "clipboard", "-o"],
			["xsel", "--clipboard", "--output"],
		]);
	});

	it("uses the xsel fallback when wl-paste fails in a mixed Wayland/X11 session", async () => {
		setPlatform("linux");
		process.env.WAYLAND_DISPLAY = "wayland-0";
		process.env.DISPLAY = ":0";
		const calls: SpawnCall[] = [];
		spySpawn(calls, ["", "", "from xsel"], [1, 1, 0]);

		expect(await readTextFromClipboard()).toBe("from xsel");
		expect(calls.map(call => call.cmd)).toEqual([
			["wl-paste", "--type", "text/plain", "--no-newline"],
			["xclip", "-selection", "clipboard", "-o"],
			["xsel", "--clipboard", "--output"],
		]);
	});

	it("returns pbpaste stdout on darwin without touching execSync", async () => {
		setPlatform("darwin");
		const calls: SpawnCall[] = [];
		spySpawn(calls, "hello from pbpaste");

		expect(await readTextFromClipboard()).toBe("hello from pbpaste");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["pbpaste"]);
	});

	it("returns an empty string when the subprocess exits non-zero", async () => {
		setPlatform("darwin");
		spySpawn([], "", 1);

		expect(await readTextFromClipboard()).toBe("");
	});

	it("keeps the event loop responsive while the clipboard tool runs (#4235)", async () => {
		setPlatform("darwin");

		// Simulate a slow pbpaste: its stdout stream only emits after a real
		// setTimeout, so the event loop must be free during the read. Under the
		// pre-fix execSync path, this would spin the child synchronously and
		// starve every setInterval tick.
		const DELAY_MS = 80;
		const slowProc = {
			pid: 1,
			stdout: new ReadableStream<Uint8Array>({
				async start(controller) {
					await Bun.sleep(DELAY_MS);
					controller.enqueue(new TextEncoder().encode("payload"));
					controller.close();
				},
			}),
			stderr: streamOf(""),
			exitCode: 0,
			exited: (async () => {
				await Bun.sleep(DELAY_MS);
				return 0;
			})(),
			kill: () => true,
		} as unknown as Subprocess;
		vi.spyOn(Bun, "spawn").mockReturnValue(slowProc);

		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 10);
		try {
			const text = await readTextFromClipboard();
			expect(text).toBe("payload");
		} finally {
			clearInterval(timer);
		}
		// If the read blocked the loop, ticks would stay at 0. A yielding
		// implementation fires several ticks in the ~80ms window.
		expect(ticks).toBeGreaterThanOrEqual(2);
	});
});
