import { expect, test } from "bun:test";
import { expandEmoticons, tryEmojiInlineReplace } from "./emoji-autocomplete";

test("letter and number list markers remain text while explicit sunglasses emoticons expand", () => {
	expect(expandEmoticons("B) second option\n8) eighth option")).toBe("B) second option\n8) eighth option");
	expect(tryEmojiInlineReplace("B)")).toBeNull();
	expect(tryEmojiInlineReplace("8)")).toBeNull();
	expect(expandEmoticons("B-) 8-)")).toBe("😎 😎");
});
