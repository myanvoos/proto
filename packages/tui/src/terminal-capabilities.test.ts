import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import { detectKittyUnicodePlaceholdersSupport } from "./kitty-graphics";
import {
	detectStyledUnderlineSupport,
	detectTerminalId,
	getTerminalInfo,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	renderImage,
	resolveImageProtocol,
	setTerminalImageProtocol,
	shouldEnableHyperlinksByDefault,
	shouldEnableSynchronizedOutputByDefault,
	TERMINAL,
} from "./terminal-capabilities";

const TERMINAL_ENV_KEYS = [
	"PI_FORCE_IMAGE_PROTOCOL",
	"PI_KITTY_PLACEHOLDERS",
	"PI_NO_KITTY_PLACEHOLDERS",
	"PASEO_TERMINAL_ID",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"VSCODE_PID",
	"ALACRITTY_WINDOW_ID",
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"TMUX",
	"STY",
	"ZELLIJ",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
] as const;

function subprocessEnv(overrides: Record<string, string>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...Bun.env };
	for (const key of TERMINAL_ENV_KEYS) delete env[key];
	return { ...env, ...overrides };
}

async function renderImageInSubprocess(overrides: Record<string, string>): Promise<string[]> {
	const source = `
import { Image } from "./src/components/image.ts";
const image = new Image("AA==", "image/png", { fallbackColor: value => value }, {}, { widthPx: 1, heightPx: 1 });
console.log(JSON.stringify(image.render(20)));
`;
	const proc = Bun.spawn({
		cmd: [process.execPath, "--eval", source],
		cwd: import.meta.dir.replace(/\/src$/u, ""),
		env: subprocessEnv(overrides),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	return JSON.parse(stdout) as string[];
}

describe("embedded terminal graphics boundaries", () => {
	it("renders a text fallback instead of Kitty escape bytes inside Paseo", async () => {
		const env = { TERM_PROGRAM: "kitty", PASEO_TERMINAL_ID: "pane-1" };
		expect(detectTerminalId(env)).toBe("kitty");
		expect(resolveImageProtocol("kitty", env, true)).toBeNull();
		expect(await renderImageInSubprocess(env)).toEqual(["[Image: [image/png] 1x1]"]);
	});

	it("renders a text fallback when a Ghostty identity leaks into a Herdr pane", async () => {
		const env = { TERM_PROGRAM: "ghostty", HERDR_PANE_ID: "pane-1" };
		expect(detectTerminalId(env)).toBe("ghostty");
		expect(resolveImageProtocol("ghostty", env, true)).toBeNull();
		expect(await renderImageInSubprocess(env)).toEqual(["[Image: [image/png] 1x1]"]);
	});

	it("preserves Kitty graphics for a directly detected terminal", () => {
		expect(resolveImageProtocol("kitty", { TERM_PROGRAM: "kitty" }, true)).toBe(ImageProtocol.Kitty);
	});
});

describe("Herdr synchronized output policy", () => {
	it("enables DECSET 2026 for canonical and pane identity signals", () => {
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_ENV: "1" }, "base")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_PANE_ID: "pane-1" }, "ghostty")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_TAB_ID: "tab-1", TMUX: "1" }, "kitty")).toBe(true);
		expect(shouldEnableSynchronizedOutputByDefault({ HERDR_WORKSPACE_ID: "workspace-1" }, "base")).toBe(true);
	});

	it("does not mistake client-only Herdr socket configuration for a pane", () => {
		expect(
			shouldEnableSynchronizedOutputByDefault({ HERDR_SOCKET_PATH: "/tmp/herdr.sock", TMUX: "1" }, "kitty"),
		).toBe(false);
	});
});

describe("image protocol fallback", () => {
	it("does not infer Kitty graphics from a bare screen/tmux TERM", () => {
		expect(resolveImageProtocol("base", subprocessEnv({ TERM: "screen-256color" }), true)).toBeNull();
		expect(resolveImageProtocol("base", subprocessEnv({ TERM: "tmux-256color" }), true)).toBeNull();
	});

	it("still infers Kitty graphics from a ghostty TERM", () => {
		expect(resolveImageProtocol("base", subprocessEnv({ TERM: "xterm-ghostty" }), true)).toBe(ImageProtocol.Kitty);
	});
});

describe("TERM_PROGRAM-only terminal identities", () => {
	it("routes rio and otty images through Kitty placeholders with hyperlinks", () => {
		for (const program of ["rio", "otty"] as const) {
			const env = { TERM_PROGRAM: program };
			const id = detectTerminalId(env);
			expect(id).toBe(program);
			expect(resolveImageProtocol(id, env, true)).toBe(ImageProtocol.Kitty);
			expect(detectKittyUnicodePlaceholdersSupport(id, env)).toBe(true);
			expect(shouldEnableHyperlinksByDefault(env, id)).toBe(true);
		}
	});

	it("measures Hangul Compatibility Jamo at two cells in Orca", () => {
		const id = detectTerminalId({ TERM_PROGRAM: "Orca", TERM: "xterm-256color", COLORTERM: "truecolor" });
		expect(id).toBe("orca");
		expect(getTerminalInfo(id).hangulJamoWidth).toBe(2);
	});
});

describe("kitty placement parsing", () => {
	it("parses tmux-wrapped placements for viewport clipping", () => {
		const inner = "\x1b7\x1b[4A\x1b_Ga=p,q=2,C=1,i=7,p=9,c=10,r=3\x1b\\\x1b8";
		const wrapped = `\x1bPtmux;${inner.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
		expect(parseKittyDirectPlacementLine(wrapped)).toEqual({
			imageId: 7,
			placementId: 9,
			columns: 10,
			rows: 3,
		});
	});

	it("still parses unwrapped placements", () => {
		expect(parseKittyDirectPlacementLine("\x1b7\x1b[4A\x1b_Ga=p,q=2,C=1,i=7,c=10,r=3\x1b\\")).toEqual({
			imageId: 7,
			placementId: undefined,
			columns: 10,
			rows: 3,
		});
	});
});

describe("renderImage dimension validation", () => {
	it("rejects non-positive or non-finite dimensions instead of emitting NaN geometry", () => {
		const previous = TERMINAL.imageProtocol;
		setTerminalImageProtocol(ImageProtocol.Kitty);
		try {
			expect(renderImage("aGk=", { widthPx: 0, heightPx: 10 })).toBeNull();
			expect(renderImage("aGk=", { widthPx: 10, heightPx: 0 })).toBeNull();
			expect(renderImage("aGk=", { widthPx: -5, heightPx: 10 })).toBeNull();
			expect(renderImage("aGk=", { widthPx: Number.NaN, heightPx: 10 })).toBeNull();
			expect(renderImage("aGk=", { widthPx: 8, heightPx: 8 })).not.toBeNull();
		} finally {
			setTerminalImageProtocol(previous);
		}
	});
});

describe("Herdr pane notifications", () => {
	const keys = ["HERDR_PANE_ID", "HERDR_ENV", "CMUX_SURFACE_ID", "PI_NOTIFICATIONS"] as const;
	const saved = new Map(keys.map(key => [key, Bun.env[key]]));
	afterEach(() => {
		vi.restoreAllMocks();
		for (const [key, value] of saved) {
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	});

	function deliver(message: Parameters<ReturnType<typeof getTerminalInfo>["sendNotification"]>[0]): string[][] {
		const spawned: string[][] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(((options: { cmd: string[] }) => {
			spawned.push(options.cmd);
			return { unref() {} };
		}) as unknown as typeof Bun.spawn);
		const previousHeadless = setTerminalHeadless(false);
		try {
			getTerminalInfo("base").sendNotification(message);
		} finally {
			setTerminalHeadless(previousHeadless);
		}
		return spawned;
	}

	it("routes through herdr before an outer cmux surface, ringing request for errors", () => {
		delete Bun.env.PI_NOTIFICATIONS;
		Bun.env.HERDR_PANE_ID = "pane-1";
		Bun.env.CMUX_SURFACE_ID = "01234567-89ab-cdef-0123-456789abcdef";
		expect(deliver({ title: "Build", body: "failed", type: "error" })).toEqual([
			["herdr", "notification", "show", "Build", "--body", "failed", "--sound", "request"],
		]);
		expect(deliver({ title: "Done", body: "ok", type: "completion" })[0]?.at(-1)).toBe("done");
	});

	it("never passes a usage token as the herdr title", () => {
		delete Bun.env.PI_NOTIFICATIONS;
		Bun.env.HERDR_PANE_ID = "pane-1";
		// herdr reads a bare usage token in the title slot as a help request.
		expect(deliver({ title: "--help", body: "b" })[0]?.[3]).toBe("Proto");
	});
});

describe("styled underline capability", () => {
	it("enables the colon form only for proven terminals outside multiplexers", () => {
		expect(detectStyledUnderlineSupport("kitty", {})).toBe(true);
		expect(detectStyledUnderlineSupport("kitty", { TMUX: "/tmp/tmux-1/default,1,0" })).toBe(false);
		// Apple Terminal detects as base/trueColor.
		expect(detectStyledUnderlineSupport("trueColor", { TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
	});

	it("requires a confirmed iTerm2 3.5 or newer", () => {
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "3.4.23" })).toBe(false);
		expect(detectStyledUnderlineSupport("iterm2", { TERM_PROGRAM_VERSION: "3.5.0" })).toBe(true);
		expect(detectStyledUnderlineSupport("iterm2", {})).toBe(false);
	});
});

describe("tmux client terminal resolution", () => {
	it.skipIf(process.platform === "win32")("adopts the attached client's terminal profile inside tmux", async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-tmux-client-"));
		try {
			const tmux = path.join(binDir, "tmux");
			await Bun.write(
				tmux,
				`#!/bin/sh
[ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = '#{client_termtype}' ] || exit 64
printf "%s\\n" "WezTerm 20260905-175422-0f4b5596"
`,
			);
			await fs.chmod(tmux, 0o755);
			const env = subprocessEnv({
				TERM: "tmux-256color",
				TERM_PROGRAM: "tmux",
				TERM_PROGRAM_VERSION: "3.6b",
				COLORTERM: "truecolor",
				TMUX: "/tmp/tmux-1000/default,4242,0",
				PATH: `${binDir}${path.delimiter}${Bun.env.PATH ?? ""}`,
			});
			for (const key of ["PI_TEST_RUNTIME", "BUN_ENV", "NODE_ENV"]) delete env[key];
			const proc = Bun.spawn({
				cmd: [
					process.execPath,
					"--eval",
					`import { TERMINAL_ID } from "./src/terminal-capabilities.ts";\nconsole.log(TERMINAL_ID);`,
				],
				cwd: import.meta.dir.replace(/\/src$/u, ""),
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			expect(stdout.trim()).toBe("wezterm");
		} finally {
			await fs.rm(binDir, { force: true, recursive: true });
		}
	});
});
