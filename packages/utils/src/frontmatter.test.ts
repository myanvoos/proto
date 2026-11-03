import { expect, test } from "bun:test";
import { parseFrontmatter } from "./frontmatter";

test("frontmatter repair preserves body comments and plain HTML documents", () => {
	const body = "Body <!-- keep this --> text";
	expect(parseFrontmatter(`<!-- header -->\n---\nname: example <!-- metadata -->\n---\n${body}`)).toEqual({
		frontmatter: { name: "example" },
		body,
	});
	const plain = "<!-- plain -->\nText <!-- retained -->";
	expect(parseFrontmatter(plain).body).toBe(plain);
});
