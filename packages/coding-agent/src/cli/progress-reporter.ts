const BAR_WIDTH = 16;

interface ProgressOutput {
	isTTY?: boolean;
	write(text: string): boolean;
}

export interface ProgressReporter {
	readonly interactive: boolean;
	start(total: number): void;
	complete(): void;
	finish(): void;
}

export function createProgressReporter(label: string, output: ProgressOutput = process.stdout): ProgressReporter {
	const interactive = output.isTTY === true;
	let total = 0;
	let completed = 0;
	let rendered = false;

	const render = (): void => {
		if (!interactive || total === 0) return;
		const ratio = Math.min(completed / total, 1);
		const filled = Math.round(ratio * BAR_WIDTH);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
		output.write(`\r${label} [${bar}] ${completed}/${total}\x1b[K`);
		rendered = true;
	};

	return {
		interactive,
		start(nextTotal) {
			total = Math.max(nextTotal, 0);
			completed = 0;
			render();
		},
		complete() {
			completed = Math.min(completed + 1, total);
			render();
		},
		finish() {
			if (!rendered) return;
			output.write("\n");
			rendered = false;
		},
	};
}
