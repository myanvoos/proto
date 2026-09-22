import { expect, test } from "bun:test";
import { TranscriptContainer } from "./components/transcript-container";
import { Composer } from "./composer";
import { initThemeSync } from "./theme/theme";
import { QueuedScheduler, StreamingBlock, VTermSink } from "./__w9f3-kit";

initThemeSync();

test("W9F3 repro: rapid resize while streaming keeps every block exactly once", async () => {
	const terminal = new VTermSink(120, 34);
	const scheduler = new QueuedScheduler();
	const composer = new Composer({ terminal, tuiOptions: { renderScheduler: scheduler }, preferences: { quiet: true } });
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript]);
	composer.start({ deferInput: true });
	await scheduler.flush();

	const log: string[] = [];
	const realRender = composer.renderFrame.bind(composer);
	composer.renderFrame = (viewport: { columns: number; rows: number }) => {
		const plan = realRender(viewport);
		if (plan.history)
			log.push(
				`OFFER id=${plan.history.id} w=${viewport.columns} rows=${plan.history.rows.length} kind=${String(plan.history.kind)} marks=${JSON.stringify(plan.history.rows.filter(r => /section-\d row 0 /.test(Bun.stripANSI(r))).map(r => Bun.stripANSI(r).slice(0, 18)))}`,
			);
		return plan;
	};
	const realAck = composer.acknowledgeHistory.bind(composer);
	composer.acknowledgeHistory = (id: number) => {
		log.push(`ACK  id=${id} tapeMarks=${count()}`);
		realAck(id);
	};
	const count = () =>
		terminal
			.tape()
			.filter(row => /section-1 row 0 /.test(row)).length;

	const widths = [60, 120, 60, 120];
	let resizes = 0;
	for (let block = 0; block < 6; block++) {
		const live = new StreamingBlock(`section-${block}`);
		transcript.addChild(live);
		for (let chunk = 0; chunk < 14; chunk++) {
			live.push(`section-${block} row ${chunk} ${"payload ".repeat(6)}`);
			composer.ui.requestRender();
			await scheduler.flush();
			if (block === 2 && chunk % 3 === 2 && resizes < widths.length) {
				const width = widths[resizes++]!;
				log.push(`PRE-RESIZE -> ${width} tapeMarks=${count()}`);
				terminal.resize(width, width === 60 ? 20 : 34);
				log.push(`POST-RESIZE ${width} tapeMarks=${count()}`);
				await scheduler.flush();
				log.push(`POST-FLUSH  ${width} tapeMarks=${count()}`);
			}
		}
		live.finalize();
		composer.ui.requestRender();
		await scheduler.flush();
	}
	composer.ui.requestRender();
	await scheduler.flush();

	console.log(log.join("\n"));
	const tape = terminal.tape();
	for (const [index, row] of tape.entries()) {
		if (/section-1 row \d+ /.test(row)) console.log(`TAPE[${index}] len=${row.length} :: ${row.slice(0, 70)}`);
	}
	const report: Record<string, number> = {};
	for (let block = 0; block < 6; block++) {
		report[`section-${block}`] = tape.filter(row => row.includes(`section-${block} row 0 `)).length;
	}
	console.log("first-row occurrences:", JSON.stringify(report));
	for (let block = 0; block < 6; block++) {
		expect(report[`section-${block}`], `section-${block} first row`).toBe(1);
	}
});
