import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcClient } from "./rpc-client";

// Wire frames the filter used to drop, followed by an accepted type as an
// in-order drain barrier.
const SESSION_FRAMES = [
	{ type: "config_warnings_changed" },
	{ type: "cache_warming_start" },
	{ type: "cache_warming_end" },
	{ type: "queue_update", steering: [], followUp: [], liveSteered: 0 },
];

const fixture = `
import { readLines } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils"))};
console.log(JSON.stringify({ type: "ready" }));
for await (const line of readLines(Bun.stdin.stream())) {
	const frame = JSON.parse(new TextDecoder().decode(line));
	if (frame.type === "get_state") {
		for (const event of ${JSON.stringify(SESSION_FRAMES)}) console.log(JSON.stringify(event));
	}
	console.log(JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} }));
}
`;

test("forwards config and cache-warming session events to onSessionEvent listeners", async () => {
	const temp = await TempDir.create("@rpc-session-events-");
	await using _cleanup = temp;
	const file = temp.join("agent.ts");
	await Bun.write(file, fixture);
	using client = new RpcClient({ cliPath: file, terminationGraceMs: 1 });
	await client.start();

	const types: string[] = [];
	const drained = Promise.withResolvers<void>();
	client.onSessionEvent(event => {
		types.push(event.type);
		if (types.length === SESSION_FRAMES.length) drained.resolve();
	});

	await client.getState();
	await drained.promise;

	expect(types).toEqual(SESSION_FRAMES.map(frame => frame.type));
});
