import { expect, test } from "bun:test";
import type { Terminal } from "@oh-my-pi/pi-tui";
import { beginStartupComposer, stopPendingStartupComposer, takeStartupComposerLease } from "./startup-composer";

class SilentTerminal implements Terminal {
	columns = 100;
	rows = 30;
	readonly writes: string[] = [];

	start(): void {}
	stop(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(data: string): void {
		this.writes.push(data);
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
	get appearance(): undefined {
		return undefined;
	}
}

test("startup prepaint renders before recent-session discovery begins", async () => {
	const terminal = new SilentTerminal();
	const gate = Promise.withResolvers<void>();
	let discoveryStarted = false;

	try {
		beginStartupComposer({
			terminal,
			cache: false,
			recentSessions: async () => {
				discoveryStarted = true;
				await gate.promise;
				return [{ name: "deferred session", timeAgo: "now" }];
			},
		});

		expect(discoveryStarted).toBe(false);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(terminal.writes.length).toBeGreaterThan(0);
		expect(discoveryStarted).toBe(true);

		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		gate.resolve();
		await new Promise<void>(resolve => setImmediate(resolve));
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(lease!.composer.welcome?.render(100).join("\n")).toContain("deferred session");
		lease!.dispose();
	} finally {
		stopPendingStartupComposer();
	}
});
