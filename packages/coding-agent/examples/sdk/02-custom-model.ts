import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getModel } from "@oh-my-pi/pi-ai";
import { createAgentSession, discoverAuthStorage, discoverModels } from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = await discoverModels(authStorage);

const opus = getModel("anthropic", "claude-opus-4-5");
if (opus) {
	console.log(`Found model: ${opus.provider}/${opus.id}`);
}

const customModel = modelRegistry.find("my-provider", "my-model");
if (customModel) {
	console.log(`Found custom model: ${customModel.provider}/${customModel.id}`);
}

const available = modelRegistry.getAvailable();
console.log(
	"Available models:",
	available.map(m => `${m.provider}/${m.id}`),
);

if (available.length > 0) {
	const { session } = await createAgentSession({
		model: available[0],
		thinkingLevel: ThinkingLevel.Medium,
		authStorage,
		modelRegistry,
	});

	session.subscribe(event => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("Say hello in one sentence.");
	console.log();
}
