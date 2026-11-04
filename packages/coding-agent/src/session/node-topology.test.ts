import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readNodeTopology } from "./node-topology";
import { SessionManager } from "./session-manager";

test("a committed temporal cut recovers after restart without rewinding its later continuation", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-node-recovery-"));
	const file = path.join(directory, "root.jsonl");
	try {
		const source = await SessionManager.open(file, undefined, undefined, {
			initialCwd: directory,
			suppressBreadcrumb: true,
		});
		await source.setNodeTopology({
			id: source.getSessionId(),
			rootId: source.getSessionId(),
			rootSessionFile: file,
			generation: 0,
			state: "active",
		});
		const boundary = source.appendCustomEntry("boundary", { value: 1 });
		source.appendCustomEntry("abandoned-continuation", { value: 2 });
		const node = source.getNodeTopology()!;
		await source.flush();
		await source.close();
		await expect(source.setNodeTopology({ ...node, generation: 9 })).rejects.toThrow("released session journal");
		await Bun.write(
			`${file}.temporal.json`,
			JSON.stringify({
				version: 1,
				sourceNodeId: node.id,
				sourceGeneration: 1,
				boundaryEntryId: boundary,
				abandoned: [],
			}),
		);
		const recovered = await SessionManager.open(file, undefined, undefined, {
			suppressBreadcrumb: true,
			throwIfMissing: true,
		});
		expect(recovered.getLeafId()).toBe(boundary);
		expect(recovered.getNodeTopology()?.generation).toBe(1);
		const continuation = recovered.appendCustomEntry("accepted-continuation", { value: 3 });
		await recovered.flush();
		await recovered.close();
		const restarted = await SessionManager.openReadOnly(file);
		try {
			expect(restarted.getLeafId()).toBe(continuation);
		} finally {
			await restarted.close();
		}
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("a committed parent abandonment rejects descendant revival before child header writes finish", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "proto-node-abandon-"));
	try {
		const parentFile = path.join(directory, "parent.jsonl");
		const childFile = path.join(directory, "child.jsonl");
		const timestamp = new Date().toISOString();
		await Bun.write(
			parentFile,
			`${JSON.stringify({ type: "session", id: "parent-session", cwd: directory, timestamp, node: { id: "parent", rootId: "parent", generation: 0, state: "active" } })}\n`,
		);
		await Bun.write(
			childFile,
			`${JSON.stringify({ type: "session", id: "child-session", cwd: directory, timestamp, node: { id: "child", rootId: "parent", parentId: "parent", parentSessionFile: parentFile, generation: 0, state: "active" } })}\n`,
		);
		await Bun.write(
			`${parentFile}.temporal.json`,
			JSON.stringify({
				version: 1,
				sourceNodeId: "parent",
				sourceGeneration: 1,
				boundaryEntryId: null,
				abandoned: [{ nodeId: "child", sessionFile: childFile, generation: 1 }],
			}),
		);
		expect(await readNodeTopology(childFile)).toMatchObject({ id: "child", generation: 1, state: "abandoned" });
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
