import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Agent } from "../packages/agent/src/agent";
import { ModelRegistry } from "../packages/coding-agent/src/config/model-registry";
import { AuthStorage } from "../packages/coding-agent/src/session/auth-storage";
import { SessionManager } from "../packages/coding-agent/src/session/session-manager";
import { SessionStatsTracker, type SessionStatsTrackerHost } from "../packages/coding-agent/src/session/session-stats";
import { formatArtifact, runSuite } from "./harness";

type Fixture = {
	tracker: SessionStatsTracker;
	turns: number;
};

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected benchmark model");
const authStorages: AuthStorage[] = [];

async function buildFixture(entryCount: number): Promise<Fixture> {
	const sessionManager = SessionManager.inMemory("/bench");
	for (let index = 0; index < entryCount; index++) {
		sessionManager.appendCustomEntry("benchmark-entry", { index });
	}

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["benchmark"],
			tools: [],
			messages: [],
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage);
	const host: SessionStatsTrackerHost = {
		session: { systemPrompt: ["benchmark"] },
		agent,
		sessionManager,
		modelRegistry,
		model: () => model,
		sessionId: () => sessionManager.getSessionId(),
	};
	return { tracker: new SessionStatsTracker(host), turns: entryCount };
}

const sizes = [100, 1_000, 4_000] as const;
const artifact = await runSuite(
	"session-turn",
	sizes.map(entryCount => ({
		name: `context-breakdown-${entryCount}-entries`,
		setup: () => buildFixture(entryCount),
		run: ({ tracker, turns }: Fixture) => {
			let usedTokens = 0;
			for (let turn = 0; turn < turns; turn++) {
				usedTokens +=
					tracker.getContextBreakdown({ contextWindow: model.contextWindow ?? undefined })?.usedTokens ?? 0;
			}
			return usedTokens;
		},
	})),
);
console.log(formatArtifact(artifact));
for (const authStorage of authStorages) authStorage.close();
