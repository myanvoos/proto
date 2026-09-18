import { describe, expect, test } from "bun:test";
import { splitPdfImageReadPath } from "./read-pdf";

describe("splitPdfImageReadPath", () => {
	test("rejects arbitrary, zero, and unsafe PDF page members instead of selecting page 1", () => {
		expect(splitPdfImageReadPath("document.pdf:garbage")).toBeNull();
		expect(splitPdfImageReadPath("document.pdf:page-0.png")).toBeNull();
		expect(splitPdfImageReadPath("document.pdf:page-9007199254740992.png")).toBeNull();
	});

	test("resolves a valid PDF page member", () => {
		expect(splitPdfImageReadPath("document.pdf:page-7.png")).toEqual({
			pdfPath: "document.pdf",
			member: "page-7.png",
			page: 7,
		});
	});
});
