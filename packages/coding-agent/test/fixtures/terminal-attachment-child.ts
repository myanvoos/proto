/** Real PTY child: explicit SIGWINCH redraws even at the same size; commands report actual dimensions. */
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let screen = 0;
let input = "";
const redraw = (): void => {
	process.stdout.write(`\x1b[2J\x1b[HSCREEN:${++screen}:${process.stdout.columns}:${process.stdout.rows}\n`);
};
// Keep the TTY dimension cache synchronized, but redraw on the explicit host signal.
process.stdout.on("resize", () => {});
process.on("SIGWINCH", redraw);
process.stdin.on("data", chunk => {
	input += chunk;
	for (;;) {
		const end = input.indexOf("\n");
		if (end < 0) break;
		const command = input.slice(0, end);
		input = input.slice(end + 1);
		if (command.startsWith("size:")) {
			process.stdout.write(`SIZE:${command.slice(5)}:${process.stdout.columns}:${process.stdout.rows}\n`);
		} else if (command.startsWith("emit:")) {
			process.stdout.write(`EVENT:${command.slice(5)}\n`);
		} else if (command === "exit") {
			process.exit(0);
		}
	}
});
process.stdout.write(`PTY_READY:${process.pid}\n`);
