import { expect, test } from "bun:test";
import { loginXiaomi, loginXiaomiTokenPlan } from "./xiaomi";

test("Xiaomi login validates with MiMo V2.6 and keeps explicitly selected regional token plans local", async () => {
	const requests: string[] = [];
	const fetch: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			requests.push(String(input));
			expect(JSON.parse(String(init?.body)).model).toBe("mimo-v2.6");
			return Response.json({});
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	expect(await loginXiaomi({ onPrompt: async () => "sk-standard", fetch })).toBe("sk-standard");
	expect(await loginXiaomiTokenPlan({ onPrompt: async () => "tp-regional", fetch }, "ams")).toBe("tp-regional");
	expect(requests).toEqual([
		"https://api.xiaomimimo.com/v1/chat/completions",
		"https://token-plan-ams.xiaomimimo.com/v1/chat/completions",
	]);
});
