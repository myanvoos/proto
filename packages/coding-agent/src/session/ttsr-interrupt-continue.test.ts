/**
 * A TTSR interrupt aborts the streaming turn, injects the violated rule, and continues. The continuation can land
 * while the aborted run is still settling; treating that busy overlap as a failure dropped the rule injection.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Rule } from "../capability/rule";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { createSourceMeta } from "../discovery/helpers";
import { TtsrManager } from "../export/ttsr";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { convertToLlm } from "./messages";
import { SessionManager } from "./session-manager";

const RULE: Rule = {
	name: "no-unwrap",
	path: "rules/no-unwrap.md",
	content: "Do not use .unwrap()",
	condition: ["\\.unwrap\\("],
	_source: createSourceMeta("native", "rules/no-unwrap.md", "project"),
};

function message(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("TTSR interrupt continuation", () => {
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		auth?.close();
		auth = undefined;
	});

	it("retries the continuation when the interrupted run is still busy", async () => {
		// Post-prompt tasks wait a fixed settle delay; collapse it instead of spending real time.
		const wait = scheduler.wait.bind(scheduler);
		vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => wait(0, options));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const ttsrManager = new TtsrManager({
			enabled: true,
			contextMode: "discard",
			interruptMode: "always",
			repeatMode: "once",
			repeatGap: 10,
		});
		expect(ttsrManager.addRule(RULE)).toBe(true);
		let requests = 0;
		let sawInjection = false;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: (_model, context, options) => {
				requests++;
				const stream = createAssistantMessageEventStream();
				const signal = options?.signal;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message("") });
					if (requests === 1) {
						signal?.addEventListener(
							"abort",
							() => stream.push({ type: "error", reason: "aborted", error: message("x.unwrap(", "aborted") }),
							{ once: true },
						);
						stream.push({
							type: "text_delta",
							contentIndex: 0,
							delta: "x.unwrap(",
							partial: message("x.unwrap("),
						});
						return;
					}
					sawInjection = JSON.stringify(context.messages).includes("Do not use .unwrap()");
					stream.push({ type: "done", reason: "stop", message: message('x.expect("msg")') });
				});
				return stream;
			},
		});
		vi.spyOn(agent, "continue").mockRejectedValueOnce(new AgentBusyError());
		auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(auth),
			ttsrManager,
		});

		await session.prompt("Write some Rust code");
		await session.waitForIdle();

		expect(requests).toBe(2);
		expect(sawInjection).toBe(true);
	});
});
