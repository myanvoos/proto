import { expect, it } from "bun:test";
import { decodeDataUri } from "./openai-data-uri";

it("decodes percent-encoded binary image bytes exactly rather than through UTF-8", () => {
	const decoded = decodeDataUri("DATA:image/png,%89PNG%0D%0A%1A%0A%FF");
	expect(decoded?.mimeType).toBe("image/png");
	expect([...Buffer.from(decoded?.data ?? "", "base64")]).toEqual([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
	]);
});

it("accepts a case-insensitive base64 marker", () => {
	expect(decodeDataUri("data:image/jpeg;BASE64,/9j/")).toEqual({ data: "/9j/", mimeType: "image/jpeg" });
});
