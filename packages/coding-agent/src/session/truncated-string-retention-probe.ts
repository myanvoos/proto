import { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import { truncateHead, truncateTail } from "./streaming-output";

const EVENTS = 16;
const PARENT_BYTES = 8 * 1024 * 1024;
const WINDOW_BYTES = 32_000;

async function liveBytes(): Promise<number> {
	Bun.gc(true);
	Bun.gc(true);
	// JSC settles external-allocation accounting asynchronously after forced GC;
	// yield briefly before this isolated process samples retained memory.
	await Bun.sleep(50);
	const memory = process.memoryUsage();
	return Math.max(memory.heapUsed, memory.external);
}

function retainRawSse(): RawSseDebugBuffer {
	const buffer = new RawSseDebugBuffer();
	for (let index = 0; index < EVENTS; index++) {
		const line = `data: ${Buffer.alloc(PARENT_BYTES, 65 + (index % 26)).toString("base64")}`;
		buffer.recordEvent({ event: null, data: "{}", raw: [line] });
	}
	return buffer;
}

function retainToolOutput(): string[] {
	const retained: string[] = [];
	for (let index = 0; index < EVENTS; index++) {
		const content = Buffer.alloc(PARENT_BYTES, 65 + (index % 26))
			.toString("base64")
			.replace(/.{1024}/g, "$&\n");
		retained.push(truncateHead(content, { maxBytes: WINDOW_BYTES, maxLines: 32 }).content);
		retained.push(truncateTail(content, { maxBytes: WINDOW_BYTES, maxLines: 32 }).content);
	}
	return retained;
}

// Test-only measurement script: spawned as a subprocess by
// truncated-string-retention.test.ts. Guarded so that merely importing this
// module (it is reachable through the package's "./*" export map) does not
// allocate hundreds of megabytes or write to stdout.
if (import.meta.main) {
	const mode = process.argv.at(-1);
	const baseline = await liveBytes();
	let owner: RawSseDebugBuffer | string[];
	if (mode === "raw-sse") {
		owner = retainRawSse();
	} else if (mode === "tool-output") {
		owner = retainToolOutput();
	} else {
		throw new Error(`unknown probe mode: ${mode}`);
	}

	const retainedBytes = Math.max(0, (await liveBytes()) - baseline);
	const retainedChars =
		owner instanceof RawSseDebugBuffer ? owner.toRawText().length : owner.reduce((sum, text) => sum + text.length, 0);
	await Bun.write(Bun.stdout, `${retainedBytes}\n${retainedChars}\n`);
}
