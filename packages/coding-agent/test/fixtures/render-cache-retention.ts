import { wrapTextWithAnsi } from "@oh-my-pi/pi-tui/utils";

async function retainedHeap(): Promise<number> {
	// Real platform turns settle JSC's external string accounting after collection.
	for (let index = 0; index < 6; index++) {
		await Bun.sleep(20);
		Bun.gc(true);
	}
	return process.memoryUsage().heapUsed;
}

function fillWrapCache(character: string): number {
	let rows = 0;
	for (let index = 0; index < 1_000; index++) {
		const text = character.repeat(19_990) + String(index).padStart(10, "0");
		rows += wrapTextWithAnsi(text, 80).length;
	}
	return rows;
}

// Test-only subprocess: no live session state, global clock patches, or forced production GC.
if (import.meta.main) {
	const mode = process.argv.at(-1);
	if (mode !== "ascii" && mode !== "unicode") throw new Error(`Unknown wrapping probe mode: ${mode}`);
	const character = mode === "unicode" ? "\u0100" : "a";
	wrapTextWithAnsi(character.repeat(100), 80);
	const baseline = await retainedHeap();
	const rows = fillWrapCache(character);
	const retainedBytes = Math.max(0, (await retainedHeap()) - baseline);
	await Bun.write(Bun.stdout, JSON.stringify({ rows, retainedBytes }));
}
