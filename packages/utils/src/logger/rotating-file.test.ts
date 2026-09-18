import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "../temp";
import { RotatingFileSink } from "./rotating-file";

const tempDirs: TempDir[] = [];

afterEach(() => {
	for (const temp of tempDirs.splice(0)) temp.removeSync();
});

async function readLogFiles(directory: string): Promise<string[]> {
	const names = (await fs.readdir(directory)).filter(name => name.includes(".log")).sort();
	return Promise.all(names.map(name => Bun.file(path.join(directory, name)).text()));
}

function createSink(maxBytes: number): { directory: string; sink: RotatingFileSink } {
	const temp = TempDir.createSync("@proto-rotating-file-");
	tempDirs.push(temp);
	return {
		directory: temp.path(),
		sink: new RotatingFileSink({
			directory: temp.path(),
			filenamePrefix: "proto",
			filenameSuffix: "test",
			auditFile: temp.join("audit.json"),
			maxBytes,
			maxFiles: 10,
		}),
	};
}

describe("RotatingFileSink size limits", () => {
	it("rotates before a record would exceed a non-empty file's byte limit", async () => {
		const firstRecord = `first${os.EOL}`;
		const { directory, sink } = createSink(Buffer.byteLength(firstRecord));

		sink.write("first");
		sink.write("x");
		sink.close();

		expect(await readLogFiles(directory)).toEqual([firstRecord, `x${os.EOL}`]);
	});

	it("writes one oversized record intact to an empty file", async () => {
		const oversizedRecord = `larger than the limit${os.EOL}`;
		const { directory, sink } = createSink(4);

		sink.write("larger than the limit");
		sink.close();

		expect(await readLogFiles(directory)).toEqual([oversizedRecord]);
	});
});
