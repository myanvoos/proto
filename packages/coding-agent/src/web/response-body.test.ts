import { expect, test } from "bun:test";
import { decodeBody, readResponseBytes, readResponseText } from "./response-body";

test("provider JSON quoting meta charset retains Unicode and strips only its leading BOM", async () => {
	const json = '\uFEFF{"value":"café", "html":"<meta charset=windows-1252>"}';
	const response = new Response(json, { headers: { "content-type": "application/json" } });
	expect(JSON.parse((await readResponseText(response, 1024)) ?? "").value).toBe("café");
});

test("header charset overrides HTML sniffing while JSON never sniffs quoted markup", () => {
	const bytes = new Uint8Array([...new TextEncoder().encode('<meta charset="utf-8">caf'), 0xe9]);
	expect(decodeBody(bytes, "text/html; charset=windows-1252")).toContain("café");
	expect(decodeBody(bytes, "application/json")).toContain("caf�");
	expect(decodeBody(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), "")).toBe("a");
});

test("tiny and empty response chunks are bounded and cancel when the cap is crossed", async () => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < 1000; i++) {
				controller.enqueue(new Uint8Array());
				controller.enqueue(new Uint8Array([i % 256]));
			}
		},
		cancel() {
			cancelled = true;
		},
	});
	const response = new Response(stream);
	const result = await readResponseBytes(response, 100);
	expect(result.bytes).toEqual(new Uint8Array(Array.from({ length: 100 }, (_, i) => i)));
	expect(result.truncated).toBe(true);
	expect(cancelled).toBe(true);
	expect(response.body?.locked).toBe(false);
});

test("a body ending exactly at the byte cap is complete", async () => {
	expect(await readResponseBytes(new Response("abc"), 3)).toMatchObject({
		bytes: new TextEncoder().encode("abc"),
		truncated: false,
	});
	expect(await readResponseBytes(new Response(null, { status: 204 }), 0)).toMatchObject({
		bytes: new Uint8Array(),
		truncated: false,
	});
});
