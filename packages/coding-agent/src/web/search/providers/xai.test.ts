import { expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { searchXAI } from "./xai";

for (const { query, tools } of [
	{
		query: "release site:x.com/bun_js after:2026-10-01 before:2026-11-01",
		tools: [
			{
				type: "x_search",
				allowed_x_handles: ["bun_js"],
				from_date: "2026-10-01",
				to_date: "2026-11-01",
			},
		],
	},
	{
		query: "release site:x.com site:bun.sh",
		tools: [{ type: "web_search", filters: { allowed_domains: ["bun.sh"] } }, { type: "x_search" }],
	},
	{
		query: "release -site:x.com",
		tools: [{ type: "web_search", filters: { excluded_domains: ["x.com"] } }],
	},
	{
		query: "release from:@bun_js -from:other",
		tools: [{ type: "x_search", allowed_x_handles: ["bun_js"] }],
	},
	{
		query: "release -from:other",
		tools: [{ type: "web_search" }, { type: "x_search", excluded_x_handles: ["other"] }],
	},
]) {
	test(`xAI hosted search routes ${query} without leaking incompatible filters`, async () => {
		const fetch: FetchImpl = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			expect(body.tools).toEqual(tools);
			expect(body.tool_choice).toBe("required");
			return Response.json({ output_text: "Grounded release answer" });
		};
		const result = await searchXAI({ ...makeParams(fetch), query });
		expect(result.answer).toBe("Grounded release answer");
	});
}

test("xAI numeric annotation titles become usable source URLs", async () => {
	const url = "https://x.com/bun_js/status/123";
	const fetch: FetchImpl = async () =>
		Response.json({
			output_text: "A release.",
			annotations: [{ type: "url_citation", url, title: "123" }],
		});
	const result = await searchXAI(makeParams(fetch));
	expect(result.sources).toMatchObject([{ url, title: url }]);
	expect(result.citations).toMatchObject([{ url, title: url }]);
});

const authStorage = {
	resolver: vi.fn(() => async () => "test-key"),
	getCredentialOrigin: vi.fn(() => undefined),
	hasAuth: vi.fn(() => true),
} as unknown as AuthStorage;

function makeParams(fetch: FetchImpl) {
	return {
		query: "Bun latest release",
		systemPrompt: "xAI integration test prompt",
		authStorage,
		fetch,
	};
}

test("xAI answer extraction excludes commentary when final_answer items are present", async () => {
	const fetch: FetchImpl = async () =>
		new Response(
			JSON.stringify({
				output_text: "Searching the release notes.\nThe answer is Bun 1.3.12.",
				output: [
					{
						type: "message",
						phase: "commentary",
						content: [
							{
								type: "output_text",
								text: "Searching the release notes.",
								annotations: [{ type: "url_citation", url: "https://bun.sh" }],
							},
						],
					},
					{
						type: "message",
						phase: "final_answer",
						content: [{ type: "output_text", text: "The answer is Bun 1.3.12." }],
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);

	const response = await searchXAI(makeParams(fetch));

	expect(response.answer).toBe("The answer is Bun 1.3.12.");
});

async function answerFor(body: { output_text?: string; output: unknown[] }): Promise<string | undefined> {
	// A search source keeps responses with no extracted answer from failing as empty.
	const output = [...body.output, { type: "web_search_call", action: { sources: [{ url: "https://bun.sh" }] } }];
	const fetch: FetchImpl = async () =>
		new Response(JSON.stringify({ ...body, output }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	return (await searchXAI(makeParams(fetch))).answer;
}

const message = (text: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	content: [{ type: "output_text", text }],
	...extra,
});

test("xAI answer extraction drops unphased relay narration but keeps cited or substantive messages", async () => {
	expect(
		await answerFor({
			output_text: "I'll search for the latest Bun release.\nBun 1.3.12 is the latest release.",
			output: [
				message("I'll search for the latest Bun release."),
				{ type: "web_search_call", action: { sources: [{ url: "https://bun.com/blog/bun-v1-3-12" }] } },
				message("Bun 1.3.12 is the latest release."),
			],
		}),
	).toBe("Bun 1.3.12 is the latest release.");

	const cited = await answerFor({
		output: [
			message("I'll check the changelog."),
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text: "The changelog records the 1.3.12 patch.",
						annotations: [{ type: "url_citation", url: "https://bun.com/blog/bun-v1-3-12" }],
					},
				],
			},
			message("x".repeat(300)),
			message("Summarizing now."),
		],
	});
	expect(cited).toBe(`The changelog records the 1.3.12 patch.\n${"x".repeat(300)}\nSummarizing now.`);
});

test("xAI answer extraction ignores non-message items but accepts untyped messages", async () => {
	expect(
		await answerFor({
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "Considering what to search." }] },
				{ type: null, content: [{ type: "output_text", text: "Bun 1.3.12 is the latest release." }] },
			],
		}),
	).toBe("Bun 1.3.12 is the latest release.");

	expect(
		await answerFor({
			output_text: "Bun 1.3.12 is the latest release.",
			output: [{ type: "reasoning", phase: "commentary" }, { action: { type: "search", query: "Bun" } }],
		}),
	).toBe("Bun 1.3.12 is the latest release.");
});

test("xAI answer extraction never promotes the aggregate or narration when the final message is empty", async () => {
	expect(
		await answerFor({
			output_text: "Searching now.\n",
			output: [
				message("Searching now.", { phase: "commentary" }),
				{ type: "message", phase: "final_answer", content: [] },
			],
		}),
	).toBeUndefined();

	expect(
		await answerFor({
			output_text: "Let me look that up.",
			output: [message("Let me look that up."), { type: "message", content: [] }],
		}),
	).toBeUndefined();

	expect(
		await answerFor({
			output: [message("Let me look that up."), message("Still searching.", { phase: "commentary" })],
		}),
	).toBeUndefined();
});

test("xAI answer extraction treats unrecognized phases as unphased", async () => {
	expect(
		await answerFor({
			output: [message("Narration.", { phase: "commentary" }), message("Bun 1.3.12.", { phase: "" })],
		}),
	).toBe("Bun 1.3.12.");
});

test.each([
	[
		"news site:x.com after:2026-10-01 before:2026-11-01",
		[{ type: "x_search", from_date: "2026-10-01", to_date: "2026-11-01" }],
	],
	["news site:example.com", [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }]],
	["news -site:x.com", [{ type: "web_search", filters: { excluded_domains: ["x.com"] } }]],
	[
		"news site:x.com site:example.com",
		[{ type: "web_search", filters: { allowed_domains: ["example.com"] } }, { type: "x_search" }],
	],
	["news from:alice -from:bob", [{ type: "x_search", allowed_x_handles: ["alice"] }]],
	["news -from:bob", [{ type: "web_search" }, { type: "x_search", excluded_x_handles: ["bob"] }]],
	["news site:x.com/alice", [{ type: "x_search", allowed_x_handles: ["alice"] }]],
])("xAI selects hosted search tools for %s", async (query, tools) => {
	let body: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_url, init) => {
		body = JSON.parse(String(init?.body));
		return Response.json({
			output_text: "Grounded answer",
			annotations: [{ type: "url_citation", url: "https://x.com/alice/status/1", title: "12" }],
		});
	};
	const result = await searchXAI({ ...makeParams(fetch), query });
	expect(body?.tools).toEqual(tools);
	expect(body?.tool_choice).toBe("required");
	expect(result.sources[0]?.title).toBe("https://x.com/alice/status/1");
});
