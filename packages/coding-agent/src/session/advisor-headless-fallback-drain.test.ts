/**
 * The headless advisor drain (print mode, before disposing the session) must wait through a failing advisor's
 * `retry.fallbackChains` recovery. A regression returns the moment the primary advisor model fails, disposal
 * aborts the fallback switch mid-flight, and the configured backup reviewer never runs.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentSession } from "./agent-session";
import { AuthStorage } from "./auth-storage";
import { SessionManager } from "./session-manager";

const PRIMARY_ADVISOR = "claude-sonnet-4-5";
const BACKUP_ADVISOR = "claude-opus-4-5";

describe("headless advisor drain with a fallback reviewer", () => {
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;
	let temp: TempDir | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			auth?.close();
			auth = undefined;
			await temp?.remove();
			temp = undefined;
		}
	});

	it("waits for the fallback advisor model to finish the review before reporting catch-up", async () => {
		const primaryModel = getBundledModel("anthropic", PRIMARY_ADVISOR);
		if (!primaryModel) throw new Error(`Expected bundled anthropic/${PRIMARY_ADVISOR}`);
		if (!getBundledModel("anthropic", BACKUP_ADVISOR))
			throw new Error(`Expected bundled anthropic/${BACKUP_ADVISOR}`);

		const primary = createMockModel({ responses: [{ content: ["primary answer"], stopReason: "stop" }] });
		const unavailableAdvisor = createMockModel({
			handler: () => ({ stopReason: "error", errorMessage: "503 Service Unavailable: upstream connect error" }),
		});
		const backupAdvisor = createMockModel({ handler: () => ({ content: [], stopReason: "stop" }) });
		const advisorStreamFn = (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream =>
			model.id === BACKUP_ADVISOR
				? backupAdvisor.stream(model, context, options)
				: unavailableAdvisor.stream(model, context, options);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { advisor: [`anthropic/${BACKUP_ADVISOR}`] },
		});
		settings.setModelRole("advisor", `anthropic/${PRIMARY_ADVISOR}`);
		temp = TempDir.createSync("@proto-advisor-fallback-drain-");
		auth = await AuthStorage.create(":memory:");
		auth.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [] },
				streamFn: primary.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);

		session.prepareForHeadlessAdvisorDrain();
		await session.prompt("answer in one line");

		expect(await session.waitForAdvisorCatchup(10_000, { waitThroughRecovery: true })).toBe(true);
		expect(unavailableAdvisor.calls.length).toBeGreaterThanOrEqual(1);
		expect(backupAdvisor.calls).toHaveLength(1);
	}, 20_000);
});
