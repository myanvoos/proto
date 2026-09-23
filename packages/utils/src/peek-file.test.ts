import { expect, test } from "bun:test";
import { peekFile, peekFileTail } from "./peek-file";
import { TempDir } from "./temp";

test("a slice retained from an async peek survives later peeks", async () => {
	await using dir = await TempDir.create("@proto-peek-");
	const first = dir.join("first.txt");
	const second = dir.join("second.txt");
	await Bun.write(first, "first-file-contents");
	await Bun.write(second, "SECOND-FILE-CONTENTS");
	const decoder = new TextDecoder();

	const retainedHead = await peekFile(first, 10, header => header);
	const copiedHead = await peekFile(first, 10, header => header.slice(0, 5));
	const retainedTail = await peekFileTail(first, 8, tail => tail);
	await Promise.all([peekFile(second, 10, header => header), peekFileTail(second, 8, tail => tail)]);

	expect(decoder.decode(retainedHead)).toBe("first-file");
	expect(decoder.decode(copiedHead)).toBe("first");
	expect(decoder.decode(retainedTail)).toBe("contents");
});
