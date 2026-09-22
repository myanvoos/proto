import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	createInitialResponsesAssistantMessage,
	processResponsesStream,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Component, RenderScheduler, Terminal } from "@oh-my-pi/pi-tui";
import { Terminal as VTermTerminal } from "@oh-my-pi/pi-utils/vterm";
import type { ChecklistToolDetails } from "../../tools/checklist";
import { Composer } from "../composer";
import { initThemeSync, theme } from "../theme/theme";
import { AssistantMessageComponent } from "./assistant-message";
import { ToolExecutionComponent, type ToolExecutionUi } from "./tool-execution";
import { TranscriptContainer } from "./transcript-container";

initThemeSync();
class Queue implements RenderScheduler {
	jobs: Array<{ fn: () => void; off: boolean }> = [];
	now = () => 100;
	scheduleImmediate(fn: () => void): void {
		this.jobs.push({ fn, off: false });
	}
	scheduleRender(fn: () => void): { cancel(): void } {
		const job = { fn, off: false };
		this.jobs.push(job);
		return { cancel: () => (job.off = true) };
	}
	flush(): void {
		let n = 0;
		while (this.jobs.length) {
			if (++n > 20000) throw new Error("scheduler loop");
			const j = this.jobs.shift()!;
			if (!j.off) j.fn();
		}
	}
}
class VTermSink implements Terminal {
	vt: VTermTerminal;
	resizeCallback?: () => void;
	constructor(
		public columns: number,
		public rows: number,
	) {
		this.vt = new VTermTerminal({ cols: columns, rows, scrollback: 50000 });
	}
	get pendingOutputBytes() {
		return 0;
	}
	get kittyProtocolActive() {
		return false;
	}
	get kittyEnableSequence(): null {
		return null;
	}
	get appearance(): undefined {
		return undefined;
	}
	start(_input: (s: string) => void, resize: () => void): void {
		this.resizeCallback = resize;
	}
	enableInput(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(s: string): void {
		this.vt.write(s);
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
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.vt.resize(columns, rows);
		this.resizeCallback?.();
	}
	all(): string[] {
		const b = this.vt.buffer.normal;
		return Array.from({ length: b.length }, (_, i) => clean(b.getLine(i)?.translateToString(true) ?? ""));
	}
	screen(): string[] {
		const b = this.vt.buffer.normal;
		return Array.from({ length: this.rows }, (_, i) => clean(b.getLine(b.baseY + i)?.translateToString(true) ?? ""));
	}
}
class Block implements Component {
	constructor(readonly rows: readonly string[]) {}
	render(): readonly string[] {
		return this.rows;
	}
	invalidate(): void {}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}
function clean(text: string): string {
	return Bun.stripANSI(text).trimEnd();
}
function msg(text: string, thinking: string): AssistantMessage {
	return {
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking", thinking }] : []), ...(text ? [{ type: "text", text }] : [])],
		api: "openai-completions",
		provider: "test",
		model: "test",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
}
function setup(columns: number, rows: number) {
	const terminal = new VTermSink(columns, rows),
		scheduler = new Queue();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { quiet: true },
	});
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript]);
	composer.start({ deferInput: true });
	scheduler.flush();
	return { terminal, scheduler, composer, transcript };
}
function frame(composer: Composer, scheduler: Queue): void {
	composer.ui.requestRender();
	scheduler.flush();
}
function boundary(terminal: VTermSink): void {
	const screen = terminal.screen();
	const line = screen.findLastIndex(r => r.length > 0 && r === theme.boxSharp.horizontal.repeat(r.length));
	expect(line, JSON.stringify(screen)).toBeGreaterThanOrEqual(0);
	expect(
		screen.slice(line).some(r => /FINAL-TURN-|FINAL-ONE/.test(r)),
		JSON.stringify(screen),
	).toBe(false);
}
const THINK = "Inspect native history, the mutable head, Markdown boundaries, and the viewport before answering.";
const ANSWER = `FINAL-ONE survives exactly once.\n\nThe finalized prefix belongs to history while the mutable suffix stays live.\n\n## Findings\n\n- Stable paragraphs retire once.\n- Open Markdown stays mutable.\n\n\`\`\`ts\nconst frame = render(width);\n\`\`\`\n\nClosing prose exercises **bold** and \`code\`.`;
for (const [columns, rows] of [
	[55, 18],
	[100, 14],
] as const)
	test(`streams through real Composer ${columns}x${rows}`, () => {
		const { terminal, scheduler, composer, transcript } = setup(columns, rows);
		try {
			transcript.addChild(new Block(Array.from({ length: 20 }, (_, i) => `prior-${i}`)));
			const reply = new AssistantMessageComponent(undefined, false);
			transcript.addChild(reply);
			for (let n = 5; n < THINK.length; n += 5) {
				reply.updateContent(msg("", THINK.slice(0, n)), { transient: true });
				frame(composer, scheduler);
			}
			for (let n = 8; n < ANSWER.length; n += 8) {
				reply.updateContent(msg(ANSWER.slice(0, n), THINK), { transient: true });
				frame(composer, scheduler);
			}
			reply.updateContent(msg(ANSWER, THINK));
			reply.markTranscriptBlockFinalized();
			frame(composer, scheduler);
			composer.beginHistoryFlush();
			frame(composer, scheduler);
			expect(terminal.all().filter(r => r.includes("FINAL-ONE"))).toHaveLength(1);
			boundary(terminal);
		} finally {
			composer.stop();
		}
	});

for (const replacement of [true, false]) {
	test(`provider final ${replacement ? "replacement" : "append"} survives native history exactly once`, async () => {
		const { terminal, scheduler, composer, transcript } = setup(40, 24);
		try {
			transcript.addChild(new Block(Array.from({ length: 30 }, (_, i) => `retained-history-${i}`)));
			const reply = new AssistantMessageComponent();
			transcript.addChild(reply);
			const delta = `STREAMED-PREFIX\n\n${"Long paragraph 日本語. ".repeat(40)}`;
			const final = replacement ? "AUTHORITATIVE-FINAL" : `${delta}\n\nAUTHORITATIVE-FINAL`;
			const output = createInitialResponsesAssistantMessage("openai-responses", "openai-test", "test-model");
			const model = buildModel({
				id: "transcript-test",
				name: "Transcript Test",
				api: "openai-responses",
				provider: "openai-test",
				baseUrl: "https://unused.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 16_384,
				maxTokens: 1_024,
			});
			const events = [
				{
					type: "response.output_item.added",
					output_index: 0,
					sequence_number: 1,
					item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] },
				},
				{
					type: "response.output_text.delta",
					content_index: 0,
					delta,
					item_id: "m1",
					logprobs: [],
					output_index: 0,
					sequence_number: 2,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					sequence_number: 3,
					item: {
						type: "message",
						id: "m1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: final, annotations: [] }],
					},
				},
			] as unknown as ResponseStreamEvent[];
			async function* source(): AsyncGenerator<ResponseStreamEvent> {
				yield events[0]!;
				yield events[1]!;
				reply.updateContent(output, { transient: true });
				frame(composer, scheduler);
				expect(transcript.emittedStableRows()[1]).toBeGreaterThan(0);
				expect(terminal.all().filter(row => row.includes("STREAMED-PREFIX"))).toHaveLength(1);
				yield events[2]!;
			}
			await processResponsesStream(source(), output, new AssistantMessageEventStream(), model);
			expect(output.content.find(part => part.type === "text")?.text).toBe(final);
			reply.updateContent(output);
			reply.markTranscriptBlockFinalized();
			frame(composer, scheduler);
			expect(terminal.all().filter(row => row.includes("AUTHORITATIVE-FINAL"))).toHaveLength(1);
			composer.beginHistoryFlush();
			frame(composer, scheduler);
			frame(composer, scheduler);
			expect(terminal.all().filter(row => row.includes("AUTHORITATIVE-FINAL"))).toHaveLength(1);
			expect(terminal.all().filter(row => row.includes("STREAMED-PREFIX"))).toHaveLength(1);
			for (let i = 0; i < 30; i++) {
				expect(terminal.all().filter(row => row === `retained-history-${i}`)).toHaveLength(1);
			}
		} finally {
			composer.stop();
		}
	});
}

test("rejects post-final updates without a scrollback staircase", () => {
	const { terminal, scheduler, composer, transcript } = setup(56, 10);
	try {
		transcript.addChild(new Block(Array.from({ length: 10 }, (_, i) => `history-${i}`)));
		const reply = new AssistantMessageComponent(undefined, false);
		transcript.addChild(reply);
		const text = "Preserve FINALIZED-CONTINUATION exactly once after finalization.";
		for (let n = 3; n < text.length; n += 3) {
			reply.updateContent(msg(text.slice(0, n), ""), { transient: true });
			frame(composer, scheduler);
		}
		reply.updateContent(msg(text, ""));
		reply.markTranscriptBlockFinalized();
		frame(composer, scheduler);
		for (let n = 10; n <= text.length; n++) {
			reply.updateContent(msg(text.slice(0, n), ""), { transient: true });
			frame(composer, scheduler);
		}
		composer.beginHistoryFlush();
		frame(composer, scheduler);
		expect(terminal.all().filter(r => r.includes("FINALIZED-CONTINUATION"))).toHaveLength(1);
	} finally {
		composer.stop();
	}
});
function details(turn: number): ChecklistToolDetails {
	const phase = `Session ${turn}`;
	const tasks = Array.from({ length: 12 }, (_, index) => ({
		content: `Checklist row ${index}`,
		status: (index < 8 ? "completed" : "pending") as "completed" | "pending",
	}));
	return {
		op: "done",
		storage: "session",
		phases: [{ name: phase, tasks }],
		completedTasks: tasks.slice(0, 8).map(task => ({ phase, content: task.content })),
	};
}
test("long mixed session retains every finalized paragraph exactly once", () => {
	const { terminal, scheduler, composer, transcript } = setup(62, 17);
	const markers: string[] = [],
		cards: ToolExecutionComponent[] = [];
	let frames = 0;
	const render = (): void => {
		frame(composer, scheduler);
		frames++;
		boundary(terminal);
	};
	const ui: ToolExecutionUi = { requestRender: render, requestComponentRender: render };
	try {
		for (let turn = 0; turn < 30; turn++) {
			transcript.addChild(new Block([`> prompt ${turn}`]));
			const marker = `FINAL-TURN-${String(turn).padStart(3, "0")}-PARAGRAPH`;
			markers.push(marker);
			const thinking = `Thinking for turn ${turn}: inspect the tool, preserve history, and answer.`;
			const answer = `${marker} survives exactly once.\n\n## Turn ${turn}\n\n- First Markdown block.\n- Second Markdown block.\n\n\`\`\`text\ntag:${String(turn).padStart(3, "0")}\n\`\`\`\n\nClosing prose stays above the prompt.`;
			const reply = new AssistantMessageComponent(undefined, false);
			transcript.addChild(reply);
			for (let n = 7; n < thinking.length; n += 7) {
				reply.updateContent(msg("", thinking.slice(0, n)), { transient: true });
				render();
			}
			for (let n = 16; n < answer.length; n += 16) {
				reply.updateContent(msg(answer.slice(0, n), thinking), { transient: true });
				render();
			}
			reply.updateContent(msg(answer, thinking));
			reply.markTranscriptBlockFinalized();
			render();
			if (turn % 6 === 2) {
				const card = new ToolExecutionComponent(
					"checklist",
					{ op: "done" },
					{ useBuiltInRenderer: true },
					undefined,
					ui,
				);
				cards.push(card);
				transcript.addChild(card);
				render();
				card.updateResult(
					{ content: [{ type: "text", text: "ok" }], details: details(turn), isError: false },
					false,
				);
				card.seal();
				render();
			}
			composer.editor.setText(turn % 3 ? `draft ${turn}` : `draft ${turn}\nsecond line\nthird line`);
			composer.setStatusComponent(new Block([`HUD turn=${turn}`]));
			render();
			composer.editor.setText("");
			render();
			if (turn % 7 === 3) {
				const overlay = composer.ui.showOverlay(new Block(["overlay", `turn ${turn}`]), {
					width: 24,
					row: 1,
					col: 2,
				});
				frame(composer, scheduler);
				overlay.hide();
				render();
			}
			if (turn % 5 === 4)
				for (const [columns, rows] of [
					[48, 13],
					[84, 23],
					[62, 17],
				] as const) {
					terminal.resize(columns, rows);
					scheduler.flush();
					render();
				}
		}
		expect(frames).toBeGreaterThan(400);
		composer.beginHistoryFlush();
		render();
		const tape = terminal.all();
		const counts = markers.map(marker => [marker, tape.filter(row => row.includes(marker)).length] as const);
		expect(
			counts.filter(([, count]) => count !== 1),
			JSON.stringify(counts),
		).toEqual([]);
		boundary(terminal);
	} finally {
		for (const card of cards) card.dispose();
		composer.stop();
	}
});
