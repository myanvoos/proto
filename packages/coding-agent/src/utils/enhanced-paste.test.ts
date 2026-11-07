import { expect, test } from "bun:test";
import { EDITOR_LIMITS } from "@oh-my-pi/pi-tui/editor-limits";
import { EnhancedPasteController } from "./enhanced-paste";

function packet(status: string, mime?: string, payload = ""): string {
	return `\x1b]5522;type=read:status=${status}${mime ? `:mime=${Buffer.from(mime).toString("base64")}` : ""};${payload}\x07`;
}
function begin(controller: EnhancedPasteController, mime: string): void {
	controller.handleInput(packet("OK"));
	controller.handleInput(packet("DATA", mime));
	controller.handleInput(packet("DONE"));
}

function unexpectedNativePaste(): never {
	throw new Error("unexpected native clipboard paste");
}

test("enhanced text paste enforces aggregate decoded bytes across packets", () => {
	const texts: string[] = [];
	const statuses: string[] = [];
	const controller = new EnhancedPasteController({
		write: () => {},
		pasteText: text => texts.push(text),
		pasteImage: () => {},
		showStatus: status => statuses.push(status),
		pasteNative: unexpectedNativePaste,
	});
	const half = Buffer.from("é".repeat(EDITOR_LIMITS.draftBytes / 4)).toString("base64");
	begin(controller, "text/plain");
	controller.handleInput(packet("DATA", "text/plain", half));
	controller.handleInput(packet("DATA", "text/plain", half));
	controller.handleInput(packet("DATA", "text/plain", "YQ=="));
	controller.handleInput(packet("DONE"));
	expect(texts).toEqual([]);
	expect(statuses.some(status => status.includes("discarded"))).toBe(true);
	begin(controller, "text/plain");
	controller.handleInput(packet("DATA", "text/plain", Buffer.from("recovered").toString("base64")));
	controller.handleInput(packet("DONE"));
	expect(texts).toEqual(["recovered"]);
});

test("enhanced image paste rejects new transactions while native work is pending", async () => {
	const gate = Promise.withResolvers<void>();
	let calls = 0;
	const statuses: string[] = [];
	const controller = new EnhancedPasteController({
		write: () => {},
		pasteText: () => {},
		pasteImage: () => {
			calls++;
			return gate.promise;
		},
		showStatus: status => statuses.push(status),
		pasteNative: unexpectedNativePaste,
	});
	begin(controller, "image/png");
	controller.handleInput(packet("DATA", "image/png", "YQ=="));
	controller.handleInput(packet("DONE"));
	begin(controller, "image/png");
	controller.handleInput(packet("DATA", "image/png", "Yg=="));
	controller.handleInput(packet("DONE"));
	expect(calls).toBe(1);
	expect(statuses.some(status => status.includes("still processing"))).toBe(true);
	gate.resolve();
	await gate.promise;
	controller.disable();
});

test("enhanced paste falls back to the native clipboard when the listing has no supported MIME type", () => {
	const writes: string[] = [];
	const statuses: string[] = [];
	let nativeAvailable = true;
	let nativePastes = 0;
	const controller = new EnhancedPasteController({
		write: data => writes.push(data),
		pasteText: () => {},
		pasteImage: () => {},
		showStatus: status => statuses.push(status),
		pasteNative: () => {
			nativePastes++;
			return nativeAvailable;
		},
	});

	// macOS screenshots copied straight to the clipboard list only `image/tiff` (#17696).
	begin(controller, "image/tiff");
	expect(nativePastes).toBe(1);
	expect(writes).toEqual([]);
	expect(statuses).toEqual([]);

	// Remote session: the native clipboard is not the user's, so report the unsupported listing.
	nativeAvailable = false;
	begin(controller, "text/html");
	expect(nativePastes).toBe(2);
	expect(writes).toEqual([]);
	expect(statuses).toEqual(["Clipboard paste has no supported text or image data"]);
});

test("enhanced paste does not read the regular clipboard for an unsupported primary-selection listing", () => {
	const statuses: string[] = [];
	const controller = new EnhancedPasteController({
		write: () => {},
		pasteText: () => {},
		pasteImage: () => {},
		showStatus: status => statuses.push(status),
		pasteNative: unexpectedNativePaste,
	});

	controller.handleInput(packet("OK:loc=primary"));
	controller.handleInput(packet("DATA", "image/tiff"));
	controller.handleInput(packet("DONE"));

	expect(statuses).toEqual(["Clipboard paste has no supported text or image data"]);
});
