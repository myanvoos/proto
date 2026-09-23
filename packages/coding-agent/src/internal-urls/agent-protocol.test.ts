import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentProtocolHandler } from "./agent-protocol";
import { registerArtifactsDir } from "./registry-helpers";
import type { InternalUrl } from "./types";

test("nested worker output remains recoverable after its live registration is gone", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-agent-recovery-"));
	const unregister = registerArtifactsDir(root);
	try {
		const nested = path.join(root, "parent-worker");
		await fs.mkdir(nested);
		const id = "nested-worker-recovery";
		await Bun.write(path.join(nested, `${id}.jsonl`), `${JSON.stringify({ type: "session", id })}\n`);
		const output = path.join(nested, `${id}.md`);
		await Bun.write(output, JSON.stringify({ result: "persisted final output" }));
		const handler = new AgentProtocolHandler();
		const url = Object.assign(new URL(`agent://${id}`), { rawHost: id }) satisfies InternalUrl;
		const resource = await handler.resolve(url);
		expect(resource.sourcePath).toBe(output);
		expect(JSON.parse(resource.content)).toEqual({ result: "persisted final output" });
		url.searchParams.set("q", ".result");
		expect(JSON.parse((await handler.resolve(url)).content)).toBe("persisted final output");
	} finally {
		unregister();
		await fs.rm(root, { recursive: true, force: true });
	}
});
