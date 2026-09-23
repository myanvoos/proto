import { expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { initThemeSync } from "../theme/theme";
import { ReadToolGroupComponent } from "./read-tool-group";

initThemeSync();

const png: ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

function rows(group: ReadToolGroupComponent): string[] {
	return group.render(80).map(row => Bun.stripANSI(row));
}

test("a read result image renders below the read call it belongs to", () => {
	const group = new ReadToolGroupComponent();
	group.updateArgs({ path: "/tmp/shot.png" }, "call-1");
	group.setToolResultImages("call-1", [png]);
	group.updateResult({ content: [{ type: "text", text: "Read image file [image/png]" }] }, false, "call-1");

	const rendered = rows(group);
	const callRow = rendered.findIndex(row => row.includes("Read") && row.includes("shot.png"));
	const imageRow = rendered.findIndex(row => row.includes("[Image: image/png]"));
	expect(callRow).toBeGreaterThanOrEqual(0);
	expect(imageRow).toBeGreaterThan(callRow);
});

test("each read keeps its own image under its own row when several reads group together", () => {
	const group = new ReadToolGroupComponent();
	for (const [id, path] of [
		["call-1", "/tmp/one.png"],
		["call-2", "/tmp/two.png"],
	] as const) {
		group.updateArgs({ path }, id);
		group.setToolResultImages(id, [png]);
		group.updateResult({ content: [{ type: "text", text: "Read image file [image/png]" }] }, false, id);
	}

	const rendered = rows(group);
	const lastCallRow = rendered.findLastIndex(row => row.includes("Read") || row.includes(".png"));
	const imageRows = rendered.flatMap((row, index) => (row.includes("[Image: image/png]") ? [index] : []));
	expect(imageRows).toHaveLength(2);
	expect(Math.min(...imageRows)).toBeGreaterThan(lastCallRow - imageRows.length);
	expect(imageRows[0]).toBeLessThan(imageRows[1]!);
});

test("clearing a read's images drops its block and hiding tool activity hides both", () => {
	const group = new ReadToolGroupComponent();
	group.updateArgs({ path: "/tmp/shot.png" }, "call-1");
	group.setToolResultImages("call-1", [png]);
	group.updateResult({ content: [{ type: "text", text: "Read image file [image/png]" }] }, false, "call-1");
	expect(rows(group).some(row => row.includes("[Image: image/png]"))).toBe(true);

	group.setToolActivityVisible(false);
	expect(group.render(80)).toEqual([]);

	group.setToolActivityVisible(true);
	group.setToolResultImages("call-1", []);
	expect(rows(group).some(row => row.includes("[Image: image/png]"))).toBe(false);
	expect(rows(group).some(row => row.includes("shot.png"))).toBe(true);
});
