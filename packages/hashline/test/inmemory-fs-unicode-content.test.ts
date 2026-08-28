import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem } from "@oh-my-pi/hashline";

/**
 * InMemoryFilesystem unicode content get/set.
 */

describe("InMemoryFilesystem unicode content", () => {
	it("round-trips CJK, emoji, and combining marks", () => {
		const mem = new InMemoryFilesystem();
		const bodies = {
			"jp.ts": "const 名前 = '日本語';\n",
			"emoji.ts": "const x = '🙂🎉';\n",
			"accent.ts": "café\nnaïve\n",
		};
		for (const [p, body] of Object.entries(bodies)) {
			mem.set(p, body);
			expect(mem.get(p)).toBe(body);
		}
	});
});
