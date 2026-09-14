import { describe, expect, it } from "bun:test";
import {
	detectTerminalId,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	renderImage,
	resolveImageProtocol,
	setTerminalImageProtocol,
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
