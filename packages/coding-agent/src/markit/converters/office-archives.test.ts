import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";
import { DocxConverter } from "./docx";
import { EpubConverter } from "./epub";
import { PptxConverter } from "./pptx";

test("DOCX image placeholders and extracted image bytes survive lazy archive reads", async () => {
	const image = new Uint8Array([1, 2, 3, 4]);
	const input = Buffer.from(
		await encodeArchive("zip", [
			[
				"word/document.xml",
				'<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:r><w:t>Document text</w:t><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:body></w:document>',
			],
			[
				"word/_rels/document.xml.rels",
				'<Relationships><Relationship Id="rId1" Target="media/picture.png" Type="image"/></Relationships>',
			],
			["word/media/picture.png", image],
		]),
	);
	const converter = new DocxConverter();
	const omitted = await converter.convert(input, { extension: ".docx" });
	expect(omitted.markdown).toContain("Document text");
	expect(omitted.markdown).toContain("<!-- image: image_1 -->");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-docx-images-"));
	try {
		await converter.convert(input, { extension: ".docx", imageDir: root });
		expect(new Uint8Array(await Bun.file(path.join(root, "image_1.png")).arrayBuffer())).toEqual(image);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("PPTX without slide relationships finds numeric slide paths rather than silently dropping all slides", async () => {
	const slide = (text: string) =>
		`<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
	const input = Buffer.from(
		await encodeArchive("zip", [
			["ppt/presentation.xml", "<p:presentation/>"],
			["ppt/slides/slide10.xml", slide("Tenth slide")],
			["ppt/slides/slide2.xml", slide("Second slide")],
		]),
	);
	const result = await new PptxConverter().convert(input, { extension: ".pptx" });
	expect(result.markdown).toContain("# Second slide");
	expect(result.markdown).toContain("# Tenth slide");
	expect(result.markdown.indexOf("Second slide")).toBeLessThan(result.markdown.indexOf("Tenth slide"));
});

test("EPUB follows spine order across archive members and strips executable content", async () => {
	const input = Buffer.from(
		await encodeArchive("zip", [
			[
				"META-INF/container.xml",
				'<container><rootfiles><rootfile full-path="book/content.opf"/></rootfiles></container>',
			],
			[
				"book/content.opf",
				'<package><manifest><item id="last" href="last.xhtml"/><item id="first" href="first.xhtml"/></manifest><spine><itemref idref="first"/><itemref idref="last"/></spine></package>',
			],
			["book/last.xhtml", "<h1>Last chapter</h1>"],
			["book/first.xhtml", "<h1>First chapter</h1><script>unwanted code</script>"],
		]),
	);
	const result = await new EpubConverter().convert(input, { extension: ".epub" });
	expect(result.markdown).toContain("First chapter");
	expect(result.markdown).toContain("Last chapter");
	expect(result.markdown.indexOf("First chapter")).toBeLessThan(result.markdown.indexOf("Last chapter"));
	expect(result.markdown).not.toContain("unwanted code");
});
