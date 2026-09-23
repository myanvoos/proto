import { afterEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState, UserMessage } from "../types";
import { buildTransformedCodexRequestBody } from "./openai-codex-responses";
import { getOpenAIEffortControlState, planStableOpenAIEffort } from "./openai-configuration-update";
import { streamOpenAIResponses } from "./openai-responses";

interface TestItem {
	type?: string;
	role?: string;
	id?: string;
	status?: string;
	[key: string]: unknown;
}

const user = (text: string): TestItem => ({ role: "user", content: [{ type: "input_text", text }] });
const assistant = (id: string, text: string): TestItem => ({
	type: "message",
	id,
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text }],
});
const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
const shape = (items: TestItem[]) => items.map(item => item.type ?? item.role);

function freshState() {
	return getOpenAIEffortControlState<string>(new Map(), "session");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("planStableOpenAIEffort", () => {
	it("pins the baseline effort and replays a later change in position", () => {
		const state = freshState();
		expect(planStableOpenAIEffort(state, [user("one")], "low")).toBe("low");

		const third = [user("one"), assistant("msg_1", "a"), user("two")];
		expect(planStableOpenAIEffort(state, third, "high")).toBe("low");
		expect(shape(third)).toEqual(["user", "message", "configuration_update", "user"]);
		expect(third[2]).toEqual(update("high"));

		// A live item's output-only `status` does not break the anchor; the update is replayed, not duplicated.
		const next = [
			user("one"),
			{ ...assistant("msg_1", "a"), status: "in_progress" },
			user("two"),
			assistant("msg_2", "b"),
			user("three"),
		];
		expect(planStableOpenAIEffort(state, next, "high")).toBe("low");
		expect(shape(next)).toEqual(["user", "message", "configuration_update", "user", "message", "user"]);
	});

	it("appends after the latest tool result when effort changes inside a tool loop", () => {
		const state = freshState();
		planStableOpenAIEffort(state, [user("one")], "medium");
		const loop: TestItem[] = [
			user("one"),
			{ type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "c1", output: "ok" },
		];
		expect(planStableOpenAIEffort(state, loop, "low")).toBe("medium");
		expect(shape(loop).at(-1)).toBe("configuration_update");
	});

	it("drops a change back to the effort already in force", () => {
		const state = freshState();
		planStableOpenAIEffort(state, [user("one")], "low");
		const input = [user("one"), assistant("msg_1", "a"), user("two")];
		planStableOpenAIEffort(state, [...input], "high");
		const reverted = [...input];
		expect(planStableOpenAIEffort(state, reverted, "low")).toBe("low");
		expect(reverted.some(item => item.type === "configuration_update")).toBe(false);
	});

	it("re-baselines when the history under a transition is rewritten", () => {
		const state = freshState();
		planStableOpenAIEffort(state, [user("one")], "low");
		planStableOpenAIEffort(state, [user("one"), assistant("msg_1", "a"), user("two")], "high");

		const compacted = [user("summary"), assistant("msg_9", "z"), user("three")];
		expect(planStableOpenAIEffort(state, compacted, "high")).toBe("high");
		expect(compacted.some(item => item.type === "configuration_update")).toBe(false);
	});
});

const firstUser: UserMessage = { role: "user", content: "one", timestamp: 1 };
const secondUser: UserMessage = { role: "user", content: "two", timestamp: 3 };
function firstAssistant(api: AssistantMessage["api"], provider: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "a" }],
		api,
		provider,
		model: "gpt-6-astra",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function codexModel(id: string, compat?: { supportsConfigurationUpdate: boolean }): Model<"openai-codex-responses"> {
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		...(compat ? { compat } : {}),
	});
}

describe("codex configuration_update", () => {
	async function secondTurn(model: Model<"openai-codex-responses">) {
		const options = { apiKey: "token", sessionId: `${model.id}-session`, providerSessionState: new Map() };
		const turn = (messages: Context["messages"]): Context => ({ systemPrompt: ["sys"], messages });
		await buildTransformedCodexRequestBody(model, turn([firstUser]), { ...options, reasoning: "low" });
		return buildTransformedCodexRequestBody(
			model,
			turn([firstUser, firstAssistant("openai-codex-responses", "openai-codex"), secondUser]),
			{ ...options, reasoning: "high" },
		);
	}

	it("keeps gpt-6-astra's request-level effort and carries the change as an input item", async () => {
		const body = await secondTurn(codexModel("gpt-6-astra"));
		expect(body.reasoning?.effort).toBe("low");
		const input = body.input ?? [];
		const index = input.findIndex(item => item.type === "configuration_update");
		expect(input[index]).toEqual(update("high"));
		expect(input[index + 1]?.role).toBe("user");
	});

	it("sends the changed effort directly for other models and for opted-out endpoints", async () => {
		for (const model of [
			codexModel("gpt-5.6-sol"),
			codexModel("gpt-6-astra", { supportsConfigurationUpdate: false }),
		]) {
			const body = await secondTurn(model);
			expect(body.reasoning?.effort).toBe("high");
			expect(body.input?.some(item => item.type === "configuration_update")).toBe(false);
		}
	});
});

describe("openai-responses configuration_update", () => {
	const model: Model<"openai-responses"> = buildModel({
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	});

	function sse(id: string): Response {
		const events = [
			{ type: "response.created", response: { id, status: "in_progress" } },
			{
				type: "response.output_item.done",
				item: {
					type: "message",
					id: `msg_${id}`,
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id,
					status: "completed",
					usage: {
						input_tokens: 5,
						output_tokens: 3,
						total_tokens: 8,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];
		return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it("pins the request-level effort on the platform Responses endpoint", async () => {
		const providerSessionState = new Map<string, ProviderSessionState>();
		const bodies: Array<{ reasoning?: { effort?: string }; input?: TestItem[] }> = [];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : {});
			return sse(`resp_${bodies.length}`);
		});
		const run = (messages: Context["messages"], reasoning: "low" | "high") =>
			streamOpenAIResponses(
				model,
				{ systemPrompt: ["sys"], messages },
				{
					apiKey: "test-key",
					fetch: fetchMock,
					providerSessionState,
					sessionId: "astra-responses-session",
					reasoning,
				},
			).result();

		await run([firstUser], "low");
		await run([firstUser, firstAssistant("openai-responses", "openai"), secondUser], "high");

		expect(bodies[0]?.reasoning?.effort).toBe("low");
		expect(bodies[1]?.reasoning?.effort).toBe("low");
		const allItems = bodies.flatMap(body => body.input ?? []);
		expect(allItems.filter(item => item.type === "configuration_update")).toEqual([update("high")]);
		for (const state of providerSessionState.values()) state.close();
	});
});
