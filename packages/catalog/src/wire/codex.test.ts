import { describe, expect, it } from "bun:test";
import { isOfficialCodexApiUrl } from "./codex";

describe("Official Codex endpoint routing", () => {
	it("accepts backend subpaths without trusting a lookalike path or origin", () => {
		expect(isOfficialCodexApiUrl("https://chatgpt.com/backend-api/codex/responses")).toBe(true);
		expect(isOfficialCodexApiUrl("https://chatgpt.com/backend-api/")).toBe(true);
		expect(isOfficialCodexApiUrl("https://chatgpt.com/backend-api-elsewhere")).toBe(false);
		expect(isOfficialCodexApiUrl("https://chatgpt.com.evil.test/backend-api")).toBe(false);
		expect(isOfficialCodexApiUrl("http://chatgpt.com/backend-api")).toBe(false);
		expect(isOfficialCodexApiUrl("not-a-url")).toBe(false);
	});
});
