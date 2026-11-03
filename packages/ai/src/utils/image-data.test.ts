import { expect, test } from "bun:test";
import { decodeBase64ImageData } from "./image-data";

test.each([
	["YQ==", "a"],
	["YQ", "a"],
	["YWI=", "ab"],
	["YWI", "ab"],
	["YWJj", "abc"],
])("decodes canonical base64 %s without changing bytes", (encoded, expected) => {
	expect(decodeBase64ImageData(encoded).bytes?.toString("utf8")).toBe(expected);
});

test.each([
	["empty input", "", "empty image data"],
	["invalid alphabet", "YQ_", "invalid base64 image data"],
	["too much padding", "YQ===", "invalid base64 image data"],
	["short padding", "YQ=", "invalid base64 image data"],
	["extra padding", "YWI==", "invalid base64 image data"],
	["single sextet", "Y", "invalid base64 image data"],
	["four unused trailing bits", "YR==", "invalid base64 image data"],
	["two unused trailing bits", "YWJ=", "invalid base64 image data"],
] as const)("rejects %s before permissive base64 decoding", (_label, encoded, reason) => {
	expect(decodeBase64ImageData(encoded)).toEqual({ reason });
});
