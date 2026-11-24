import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../session/session-manager";
import { DECLARED_STATE_CUSTOM_TYPE } from "../../session/state-manifest";
import { capturePythonStore } from "./python-store";

function manifest(manager: SessionManager, revision: number) {
	return {
		version: 1,
		sessionId: manager.getSessionId(),
		boundaryEntryId: manager.getLeafId(),
		kernels: [],
		configurations: [],
		pythonStore: { revision, graph: null },
	};
}

/** Every custom row's payload lives in a temp spill file; losing that directory leaves rows without their data. */
async function loseSpilledPayloads(manager: SessionManager): Promise<void> {
	await manager.flush();
	manager.trimHydratedEntryCache();
	const spillDirectory = manager.getRawEntryDirectory();
	if (!spillDirectory) throw new Error("Expected the session to spill its custom rows");
	await fs.rm(spillDirectory, { recursive: true, force: true });
}

async function withSession(run: (manager: SessionManager) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-python-store-unreadable-"));
	const manager = SessionManager.create(dir, dir);
	try {
		await run(manager);
	} finally {
		await manager.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("a later intact row supersedes a declared-state row whose payload was lost", async () => {
	await withSession(async manager => {
		manager.appendCustomEntry(DECLARED_STATE_CUSTOM_TYPE, manifest(manager, 1));
		await loseSpilledPayloads(manager);
		manager.appendCustomEntry(DECLARED_STATE_CUSTOM_TYPE, manifest(manager, 2));

		expect(capturePythonStore(`owner:${crypto.randomUUID()}`, manager)).toEqual({ revision: 2, graph: null });
	});
});

test("a newest store row whose payload was lost fails with that cause instead of a TypeError", async () => {
	await withSession(async manager => {
		manager.appendCustomEntry(DECLARED_STATE_CUSTOM_TYPE, manifest(manager, 1));
		await loseSpilledPayloads(manager);

		expect(() => capturePythonStore(`owner:${crypto.randomUUID()}`, manager)).toThrow(
			/Python store state is unavailable: session entry \S+ can no longer be read back/,
		);
	});
});
