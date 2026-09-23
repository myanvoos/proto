import { expect, test } from "bun:test";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";

const COLUMNS = 120;
const ROWS = 30;

// A fatal report written while the TUI owns the cursor lands on the composer row; the TUI must hand the cursor back
// below its frame before the report is printed.
test.skipIf(process.platform === "win32")(
	"a fatal report lands below the live frame in a real PTY",
	async () => {
		const source = `
import { Input, ProcessTerminal, Text, TUI } from "./src/index.ts";
import { fatal } from "@oh-my-pi/pi-utils/postmortem";

const tui = new TUI(new ProcessTerminal(), false);
const input = new Input();
input.prompt = "╰─ ";
tui.addChild(new Text("safe transcript", 0, 0));
tui.addChild(input);
tui.setFocus(input);
tui.start({ clearScrollback: true });
await Bun.sleep(100);
await fatal(new Error("fatal PTY fixture"), "error: fatal PTY fixture\\n");
`;
		const chunks: Uint8Array[] = [];
		const closed = Promise.withResolvers<void>();
		await using terminal = new Bun.Terminal({
			cols: COLUMNS,
			rows: ROWS,
			data(_terminal, data) {
				chunks.push(data.slice());
			},
			exit() {
				closed.resolve();
			},
		});
		const proc = Bun.spawn([process.execPath, "--eval", source], {
			cwd: import.meta.dir.replace(/\/src$/u, ""),
			terminal,
		});
		const exitCode = await proc.exited;
		terminal.close();
		await closed.promise;
		expect(exitCode).toBe(1);

		const screen = new VTermTerminal({ cols: COLUMNS, rows: ROWS, scrollback: 100 });
		for (const chunk of chunks) {
			const { promise, resolve } = Promise.withResolvers<void>();
			screen.write(chunk, resolve);
			await promise;
		}
		const buffer = screen.buffer.active;
		const lines = Array.from({ length: buffer.length }, (_, row) =>
			buffer.getLine(row)?.translateToString(true).trimEnd(),
		);
		const composerRow = lines.indexOf("╰─");
		const errorRow = lines.findIndex(line => line?.includes("error: fatal PTY fixture") === true);
		expect(composerRow).toBeGreaterThanOrEqual(0);
		expect(errorRow).toBeGreaterThan(composerRow);
	},
	15_000,
);
