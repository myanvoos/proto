import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Context, FetchImpl, Model, ModelSpec, TJsonSchema } from "../types";
import { streamAnthropicMessages } from "./anthropic";

const SESSION_ID = "01a0d8ae-cf8c-74ee-b93b-d12f887b3488";
const JSON_USER_ID = JSON.stringify({ session_id: SESSION_ID });

const context: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: 0 }],
	tools: [
		{
			name: "bash",
			description: "run a bash command",
			parameters: {
				type: "object",
				properties: { command: { type: "string" } },
				required: ["command"],
			} satisfies TJsonSchema,
		},
	],
};

function claude(provider: string, id: string, baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	} satisfies ModelSpec<"anthropic-messages">);
}

const runtime = claude(
	"amazon-bedrock",
	"us.anthropic.claude-opus-5-5",
	"https://bedrock-runtime.us-east-1.amazonaws.com/anthropic",
);
const mantle = claude(
	"bedrock-mantle",
	"anthropic.claude-opus-5-5",
	"https://bedrock-mantle.us-east-1.api.aws/anthropic",
);
const gateway = claude("custom", "claude-opus-5-5", "https://claude-gateway.example.test");

type WirePayload = { metadata?: { user_id?: string }; tools?: Array<{ name: string; strict?: unknown }> };

async function sentPayload(
	model: Model<"anthropic-messages">,
	options: Parameters<typeof streamAnthropicMessages>[2] = {},
): Promise<WirePayload> {
	let payload: WirePayload | undefined;
	const fetchImpl: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			payload = JSON.parse(String(init?.body ?? "{}")) as WirePayload;
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		},
		{ preconnect: fetch.preconnect },
	);
	await streamAnthropicMessages(model, context, {
		apiKey: "bedrock-api-key",
		isOAuth: false,
		...options,
		fetch: fetchImpl,
	}).result();
	if (!payload) throw new Error("request was not sent");
	return payload;
}

function expectBedrockShape(payload: WirePayload): void {
	const bash = payload.tools?.find(tool => tool.name === "bash");
	expect(bash).toBeDefined();
	expect(bash?.strict).toBeUndefined();
	expect(payload.metadata?.user_id).toBe(SESSION_ID);
}

describe("Amazon Bedrock /anthropic requests", () => {
	it.each([
		["bedrock-runtime", runtime],
		["bedrock-mantle", mantle],
	])("drops strict tools and sends the session id from caller metadata on %s", async (_route, model) => {
		expectBedrockShape(await sentPayload(model, { metadata: { user_id: JSON_USER_ID } }));
	});

	it("reshapes strict tools and metadata that an onPayload hook restores", async () => {
		const payload = await sentPayload(runtime, {
			onPayload: params => {
				const built = params as { tools?: Array<Record<string, unknown>> };
				return {
					...built,
					tools: built.tools?.map(tool => ({ ...tool, strict: true })),
					metadata: { user_id: JSON_USER_ID },
				};
			},
		});
		expectBedrockShape(payload);
	});

	it("omits metadata whose user id cannot fit Bedrock's pattern", async () => {
		const payload = await sentPayload(runtime, { metadata: { user_id: "user{with}braces" } });
		expect(payload.metadata).toBeUndefined();
	});

	it("keeps caller metadata on other Messages endpoints", async () => {
		const payload = await sentPayload(gateway, { metadata: { user_id: JSON_USER_ID } });
		expect(payload.metadata?.user_id).toBe(JSON_USER_ID);
	});
});
