import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";
import { splitPdfImageReadPath } from "../../../tools/read-pdf";
import { PdfConverter } from "./index";

afterEach(() => vi.restoreAllMocks());

test("incomplete PDF text exposes a usable image selector for the first missing page", async () => {
	spyOn(natives, "pdfToMarkdown").mockResolvedValue({
		markdown: "Extracted page one",
		pageCount: 3,
		pagesNeedingOcr: [2, 3],
		hasEncodingIssues: false,
	});
	const result = await new PdfConverter().convert(Buffer.from("pdf fixture"), { extension: ".pdf" });
	const example = /`(doc\.pdf:page\d+\.png)`/.exec(result.markdown)?.[1];
	expect(result.markdown).toContain("Extracted page one");
	expect(example && splitPdfImageReadPath(example)?.page).toBe(2);
});
