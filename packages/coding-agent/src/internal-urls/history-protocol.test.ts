import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../registry/agent-registry";
import { HistoryProtocolHandler } from "./history-protocol";
import type { InternalUrl } from "./types";

let root: string | undefined;
afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

test("a large on-disk history is streamed into an explicitly reported bounded transcript", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-history-bounded-"));
	const file = path.join(root, "large-worker.jsonl");
	const records = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "large-worker",
			timestamp: new Date().toISOString(),
			cwd: root,
		}),
	];
	let parentId: string | null = null;
	for (let index = 0; index < 2_100; index++) {
		const id = `entry-${index}`;
		records.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					content: `${index === 0 ? "EARLIEST-MARKER" : index === 2_099 ? "LATEST-MARKER" : "body"} ${"x".repeat(4_200)}`,
					timestamp: Date.now(),
				},
			}),
		);
		parentId = id;
	}
	await Bun.write(file, `${records.join("\n")}\n`);
	AgentRegistry.global().register({
		id: "large-worker",
		label: "large worker",
		kind: "sub",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	const url = Object.assign(new URL("history://large-worker"), { rawHost: "large-worker" }) satisfies InternalUrl;

	const resource = await new HistoryProtocolHandler().resolve(url);

	expect(resource.notes?.join(" ")).toContain("Transcript bounded to the latest");
	expect(resource.content).toContain("LATEST-MARKER");
	expect(resource.content).not.toContain("EARLIEST-MARKER");
});
