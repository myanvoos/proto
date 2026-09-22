import assert from "node:assert/strict";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { Settings } from "../packages/coding-agent/src/config/settings";
import { MonitorManager } from "../packages/coding-agent/src/monitor/manager";
import type { MonitorEvent } from "../packages/coding-agent/src/monitor/types";

// Real subprocesses, output caps, event limits, and repeated disposal. No providers required.
const settings = Settings.isolated();
async function phase(label: string, cycles: number): Promise<void> {
	const started = performance.now();
	for (let index = 0; index < cycles; index++) {
		const terminal = Promise.withResolvers<MonitorEvent>();
		const events: MonitorEvent[] = [];
		const manager = new MonitorManager({
			settings,
			cwd: () => process.cwd(),
			deliver: event => {
				events.push(event);
				if (event.kind !== "output") terminal.resolve(event);
			},
		});
		const oversized = index % 3 !== 0;
		try {
			manager.start({
				command: oversized ? "printf '%8388608s' x" : "printf 'ready\\nignored\\n'",
				...(index % 3 === 2 ? { everySeconds: 1 } : {}),
				maxEvents: 1,
			});
			const result = await withTimeout(terminal.promise, 10_000, "Monitor stress did not terminate");
			assert.equal(result.kind, oversized ? "error" : "limit");
			assert.equal(manager.hasActive(), false);
			assert.deepEqual(
				events.map(event => event.kind),
				oversized ? ["error"] : ["output", "limit"],
			);
			assert.ok(events.every(event => event.text.length < 1300));
		} finally {
			await manager.dispose();
		}
		assert.equal(manager.list().length, 0);
	}
	Bun.gc(true);
	console.log(JSON.stringify({ label, cycles, milliseconds: performance.now() - started, ...process.memoryUsage() }));
}

await phase("warmup", 5);
for (let round = 1; round <= 2; round++) {
	await phase(`round-${round}-low`, 5);
	await phase(`round-${round}-high`, 100);
	await phase(`round-${round}-low-again`, 5);
}
