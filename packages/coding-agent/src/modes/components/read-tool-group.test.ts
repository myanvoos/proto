import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Settings } from "../../config/settings";
import { initThemeSync } from "../theme/theme";
import { ReadToolGroupComponent } from "./read-tool-group";

initThemeSync();

let previousImageProtocol = TERMINAL.imageProtocol;
beforeEach(() => {
	previousImageProtocol = TERMINAL.imageProtocol;
	setTerminalImageProtocol(null);
});
afterEach(() => setTerminalImageProtocol(previousImageProtocol));

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
	const imageRow = rendered.findIndex(row => row.includes("[Image:") && row.includes("image/png"));
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
	const imageRows = rendered.flatMap((row, index) =>
		row.includes("[Image:") && row.includes("image/png") ? [index] : [],
	);
	expect(imageRows).toHaveLength(2);
	expect(Math.min(...imageRows)).toBeGreaterThan(lastCallRow - imageRows.length);
	expect(imageRows[0]).toBeLessThan(imageRows[1]!);
});

test("clearing a read's images drops its block and hiding tool activity hides both", () => {
	const group = new ReadToolGroupComponent();
	group.updateArgs({ path: "/tmp/shot.png" }, "call-1");
	group.setToolResultImages("call-1", [png]);
	group.updateResult({ content: [{ type: "text", text: "Read image file [image/png]" }] }, false, "call-1");
	expect(rows(group).some(row => row.includes("[Image:") && row.includes("image/png"))).toBe(true);

	group.setToolActivityVisible(false);
	expect(group.render(80)).toEqual([]);

	group.setToolActivityVisible(true);
	group.setToolResultImages("call-1", []);
	expect(rows(group).some(row => row.includes("[Image:") && row.includes("image/png"))).toBe(false);
	expect(rows(group).some(row => row.includes("shot.png"))).toBe(true);
});

test("grouped delimited read rows hyperlink to the per-target paths the read reported", async () => {
	(await Settings.init({ inMemory: true })).override("tui.hyperlinks", "always");
	const component = new ReadToolGroupComponent();
	try {
		component.updateArgs({ path: "src/one.ts:1-5, src/two.ts:9-12" }, "read-grouped-link");
		component.updateResult(
			{
				content: [{ type: "text", text: "combined" }],
				details: {
					displayReadTargets: ["src/one.ts:1-5", "src/two.ts:9-12"],
					displayReadTargetLinks: ["/workspace/src/one.ts", "/workspace/src/two.ts"],
				},
			},
			false,
			"read-grouped-link",
		);
		const rendered = component.render(120).join("\n");
		expect(Bun.stripANSI(rendered)).toContain("Read (2)");
		const linkTargets = [...rendered.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]+)/g)].map(match => match[1]!);
		expect(linkTargets.some(uri => uri.includes("/workspace/src/one.ts"))).toBe(true);
		expect(linkTargets.some(uri => uri.includes("/workspace/src/two.ts"))).toBe(true);
	} finally {
		component.dispose();
	}
});

test("grouped Markdown previews render prose and honor raw selectors that arrive after the result", () => {
	const group = new ReadToolGroupComponent({ showContentPreview: true });
	group.updateArgs({ path: "/tmp/README.md" }, "markdown");
	group.updateResult(
		{
			content: [{ type: "text", text: "# Title\n\nSome **bold** text." }],
			details: { contentType: "text/markdown" },
		},
		false,
		"markdown",
	);
	const rendered = rows(group).join("\n");
	expect(rendered).toContain("Some bold text.");
	expect(rendered).not.toContain("**bold**");
	group.updateArgs({ path: "/tmp/README.md:raw" }, "markdown");
	expect(rows(group).join("\n")).toContain("**bold**");
});

test("raw read detail text cannot inject terminal commands into grouped previews", () => {
	const group = new ReadToolGroupComponent({ showContentPreview: true });
	group.updateArgs({ path: "/tmp/safe.txt" }, "unsafe");
	group.updateResult(
		{ content: [], details: { displayContent: { text: "visible\x1b]0;injected\x07 tail" } } },
		false,
		"unsafe",
	);
	const output = group.render(80).join("\n");
	expect(output).toContain("visible");
	expect(output).toContain("tail");
	expect(output).not.toContain("\x1b]0;");
});
