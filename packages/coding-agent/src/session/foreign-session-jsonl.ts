import { isRecord, readLines } from "@oh-my-pi/pi-utils";

export interface ForeignJsonRecord {
	readonly value: Record<string, unknown>;
	readonly line: number;
}

export async function* readForeignJsonRecords(filePath: string): AsyncGenerator<ForeignJsonRecord> {
	const decoder = new TextDecoder();
	let line = 0;
	for await (const bytes of readLines(Bun.file(filePath).stream())) {
		line += 1;
		try {
			const value: unknown = JSON.parse(decoder.decode(bytes));
			if (isRecord(value)) yield { value, line };
		} catch {}
	}
}

export async function collectForeignJsonRecords(filePath: string): Promise<ForeignJsonRecord[]> {
	const records: ForeignJsonRecord[] = [];
	for await (const record of readForeignJsonRecords(filePath)) records.push(record);
	return records;
}
