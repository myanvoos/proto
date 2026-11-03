import { afterEach, expect, test, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { AgentSession } from "../../session/agent-session";
import { AuthStorage } from "../../session/auth-storage";
import { convertToLlm } from "../../session/messages";
import { SessionManager } from "../../session/session-manager";
import { initTheme } from "../theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "../types";
import { UiHelpers } from "./ui-helpers";

await initTheme();
afterEach(() => vi.restoreAllMocks());

test("a failed compaction batch restores its own input without discarding concurrently queued extension input", async () => {
	const started = Promise.withResolvers<void>();
	const mock = createMockModel({
		responses: [
			() => {
				started.resolve();
				return { content: ["working"], delayMs: 60_000 };
			},
		],
	});
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			convertToLlm,
			streamFn: mock.stream,
			initialState: {
				model: getBundledModel("anthropic", "claude-sonnet-4-5"),
				systemPrompt: ["Test"],
				tools: [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(auth),
	});
	const running = session.prompt("first task");
	await started.promise;
	try {
		await session.sendUserMessage("before the flush", { deliverAs: "followUp" });
		const steer = session.steer.bind(session);
		let deliveries = 0;
		vi.spyOn(session, "steer").mockImplementation(async (text, images, options) => {
			if (++deliveries === 2) throw new Error("delivery failed");
			await steer(text, images, options);
			await session.sendUserMessage("during the flush", { deliverAs: "steer" });
		});
		const typed: CompactionQueuedMessage[] = [
			{ text: "typed one", mode: "steer" },
			{ text: "typed two", mode: "steer" },
		];
		const ctx = {
			session,
			compactionQueuedMessages: [...typed],
			skillCommands: new Map(),
			fileSlashCommands: new Set(),
			isKnownSlashCommand: () => false,
			updatePendingMessagesDisplay() {},
			showError() {},
			withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
		} as unknown as InteractiveModeContext;
		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });
		expect(ctx.compactionQueuedMessages).toEqual(typed);
		expect(session.getQueuedMessages()).toEqual({ steering: ["during the flush"], followUp: ["before the flush"] });
	} finally {
		await session.abort();
		await running.catch(() => {});
		await session.dispose();
		auth.close();
	}
});
