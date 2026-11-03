import { afterEach, expect, test, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { RpcClient } from "./rpc-client";

const fixture = `
import { readLines } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils"))};
console.log(JSON.stringify({ type: "ready" }));
for await (const line of readLines(Bun.stdin.stream())) {
	const frame = JSON.parse(new TextDecoder().decode(line));
 console.log(JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} }));
 if (frame.type === "prompt" && process.env.EXIT_AFTER_ACK === "1") process.exit(0);
}
`;

afterEach(() => vi.restoreAllMocks());

async function clientFixture(env?: Record<string, string>, source = fixture) {
	const temp = await TempDir.create("@rpc-client-lifecycle-");
	const file = temp.join("agent.ts");
	await Bun.write(file, source);
	return { temp, client: new RpcClient({ cliPath: file, env, terminationGraceMs: 1 }) };
}

test("acknowledged prompts reject immediately when the agent exits", async () => {
	const { temp, client } = await clientFixture({ EXIT_AFTER_ACK: "1" });
	await using _cleanup = temp;
	using _disposable = client;
	await client.start();
	await expect(client.promptAndWait("lost", undefined, 20_000)).rejects.toThrow("Agent process exited");
}, 5_000);

test("stopping the client rejects acknowledged prompts instead of leaving a timeout behind", async () => {
	const { temp, client } = await clientFixture();
	await using _cleanup = temp;
	await client.start();
	const completion = client.promptAndWait("orphaned", undefined, 20_000).catch((error: unknown) => error);
	await client.getState();
	await client.stop();
	expect(await completion).toMatchObject({ message: "Client stopped" });
});

test("a cyclic request rejects without closing a healthy RPC transport", async () => {
	const { temp, client } = await clientFixture();
	await using _cleanup = temp;
	using _disposable = client;
	await client.start();
	const images: unknown[] = [];
	images.push(images);
	await expect(client.prompt("bad", images as ImageContent[])).rejects.toThrow();
	expect(await client.getState()).toMatchObject({ fastModeEnabled: false });
});

test("a synchronous flush failure settles the request and allows restarting the client", async () => {
	const spawn = ptree.spawn;
	let child: ptree.ChildProcess | undefined;
	vi.spyOn(ptree, "spawn").mockImplementation((...args) => {
		child = spawn(...args);
		return child;
	});
	const { temp, client } = await clientFixture();
	await using _cleanup = temp;
	using _disposable = client;
	await client.start();
	if (!child?.stdin || typeof child.stdin === "number" || !("flush" in child.stdin))
		throw new Error("missing stdin sink");
	vi.spyOn(child.stdin, "flush").mockImplementation(() => {
		throw new Error("broken flush");
	});
	await expect(client.getState()).rejects.toThrow("broken flush");
	vi.restoreAllMocks();
	await client.start();
	expect(await client.getState()).toMatchObject({ fastModeEnabled: false });
});

test("OAuth manual-code listeners skip secret extension dialogs and discard replies after transport restart", async () => {
	const loginFixture = `
console.log(JSON.stringify({type: "ready"}));
for await (const line of console) {
 const frame = JSON.parse(line);
 if (frame.type === "login") {
  console.log(JSON.stringify({ type: "extension_ui_request", id: "secret", method: "input", title: "Secret", secret: true }));
  console.log(JSON.stringify({ type: "extension_ui_request", id: "manual", method: "input", title: "Code" }));
 } else console.log(JSON.stringify({ type: "response", id: frame.id, command: frame.type, success: true, data: {} }));
}
`;
	const { temp, client } = await clientFixture(undefined, loginFixture);
	await using _cleanup = temp;
	using _disposable = client;
	await client.start();
	const reached = Promise.withResolvers<void>();
	const code = Promise.withResolvers<string>();
	const titles: string[] = [];
	const login = client
		.login("oauth", {
			onManualCodeInput: prompt => {
				titles.push(prompt.title);
				reached.resolve();
				return code.promise;
			},
		})
		.catch((error: unknown) => error);
	await reached.promise;
	await client.stop();
	await client.start();
	code.resolve("stale code");
	await client.getState();
	expect(titles).toEqual(["Code"]);
	expect(await login).toMatchObject({ message: "Client stopped" });
});
