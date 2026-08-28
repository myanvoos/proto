import { logger } from "@oh-my-pi/pi-utils";

export function openPath(urlOrPath: string): void {
	const cmd = process.platform === "darwin" ? ["open", urlOrPath] : ["xdg-open", urlOrPath];
	let child: Bun.Subprocess | undefined;
	try {
		child = Bun.spawn(cmd, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} catch (error) {
		logger.warn("Failed to open external URL/path", {
			command: cmd[0],
			target: urlOrPath,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}

	child.exited.then(
		exitCode => {
			if (typeof exitCode === "number" && exitCode !== 0) {
				logger.warn("External opener exited with non-zero status", {
					command: cmd[0],
					target: urlOrPath,
					exitCode,
				});
			}
		},
		() => {},
	);
}
