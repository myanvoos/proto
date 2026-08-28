import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session: session1 } = await createAgentSession({
	systemPrompt: [
		`You are a helpful assistant that speaks like a pirate.
Always end responses with "Arrr!"`,
	],
	sessionManager: SessionManager.inMemory(),
});

session1.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

console.log("=== Replace prompt ===");
await session1.prompt("What is 2 + 2?");
console.log("\n");

const { session: session2 } = await createAgentSession({
	systemPrompt: defaultPrompt => [
		...defaultPrompt,
		`## Additional Instructions
- Always be concise
- Use bullet points when listing things`,
	],
	sessionManager: SessionManager.inMemory(),
});

session2.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

console.log("=== Modify prompt ===");
await session2.prompt("List 3 benefits of TypeScript.");
console.log();
