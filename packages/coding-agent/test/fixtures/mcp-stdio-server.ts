// Fixture stdio MCP server used by mcp tests. Invoked as:
//   bun --smol mcp-stdio-server.ts [mode] [envVars]
//
// Modes:
//   (default)     healthy: answers initialize, tools/list, tools/call
//   ignore-calls  wedged: answers initialize + tools/list, never answers tools/call
//   storm         after answering the first tools/list, emits 8
//                 notifications/tools/list_changed; later tools/list responses
//                 are staggered (request k answers after max(250-50*(k-1),50)ms)
//                 and tagged with a generation (tool_<k>) so response ordering
//                 is observable from the applied tool names. The staggering is
//                 real subprocess timing: this script is the remote server whose
//                 response latency is the stimulus under test.
//   env-probe     tools/list returns one tool whose description is JSON of the
//                 comma-separated env var names passed as argv[3], mapped to
//                 their values in the child process (null when unset); PATH and
//                 HOME are reported as booleans
import * as readline from "node:readline";

const mode = process.argv[2] ?? "healthy";

const send = (message: unknown): void => {
	process.stdout.write(`${JSON.stringify(message)}\n`);
};
const respond = (id: string | number, result: unknown): void => {
	send({ jsonrpc: "2.0", id, result });
};

function toolListPayload(generation: number): unknown {
	if (mode === "env-probe") {
		const observed: Record<string, unknown> = {};
		for (const name of (process.argv[3] ?? "")
			.split(",")
			.map(entry => entry.trim())
			.filter(Boolean)) {
			const value = process.env[name];
			observed[name] = value === undefined ? null : name === "PATH" || name === "HOME" ? true : value;
		}
		return { tools: [{ name: "env-probe", description: JSON.stringify(observed), inputSchema: { type: "object" } }] };
	}
	return { tools: [{ name: `tool_${generation}`, inputSchema: { type: "object" } }] };
}

let listRequests = 0;
let stormSent = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
	if (!line.trim()) return;
	const message = JSON.parse(line) as {
		id?: string | number;
		method?: string;
		params?: { protocolVersion?: string; arguments?: Record<string, unknown> };
	};
	if (message.id === undefined || message.id === null) return;
	const id = message.id as string | number;

	switch (message.method) {
		case "initialize":
			respond(id, {
				protocolVersion: message.params?.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "mcp-fixture", version: "1" },
			});
			break;
		case "tools/list": {
			listRequests += 1;
			const generation = listRequests;
			if (mode === "storm" && !stormSent) {
				stormSent = true;
				respond(id, toolListPayload(generation));
				for (let index = 0; index < 8; index += 1) {
					send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
				}
				return;
			}
			if (mode === "storm") {
				// Real response latency: the stagger makes out-of-order completion
				// observable (earliest request answers last).
				const delay = Math.max(250 - 50 * (generation - 1), 50);
				setTimeout(() => respond(id, toolListPayload(generation)), delay);
				return;
			}
			respond(id, toolListPayload(generation));
			break;
		}
		case "tools/call":
			if (mode === "ignore-calls") return;
			respond(id, {
				content: [{ type: "text", text: `echo: ${JSON.stringify(message.params?.arguments ?? {})}` }],
			});
			break;
		default:
			respond(id, {});
	}
});
