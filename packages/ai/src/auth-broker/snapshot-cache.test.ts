import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { REMOTE_REFRESH_SENTINEL } from "../auth-storage";
import {
	flushAuthBrokerSnapshotCacheWrites,
	readAuthBrokerSnapshotCache,
	scheduleAuthBrokerSnapshotCacheWrite,
	writeAuthBrokerSnapshotCache,
} from "./snapshot-cache";
import type { SnapshotResponse } from "./types";

function snapshot(generation: number, generatedAt: number): SnapshotResponse {
	return {
		generation,
		generatedAt,
		serverNowMs: generatedAt,
		refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
		credentials: [
			{
				id: 1,
				provider: "cursor",
				identityKey: "account",
				rotatesInMs: 90_000,
				credential: {
					type: "oauth",
					access: "access",
					refresh: REMOTE_REFRESH_SENTINEL,
					expires: 2_000_000_000_000,
				},
			},
		],
	};
}

test("cached rotation countdowns age across process restarts and never go negative", async () => {
	await using dir = await TempDir.create("@proto-snapshot-cache-");
	const options = { path: dir.join("cache"), token: "secret", url: "https://broker.example" };
	await writeAuthBrokerSnapshotCache({ ...options, snapshot: snapshot(1, 1_000_000) });
	const read = (now: number) => readAuthBrokerSnapshotCache({ ...options, ttlMs: 600_000, now: () => now });
	expect((await read(1_040_000))?.credentials[0]?.rotatesInMs).toBe(50_000);
	expect((await read(1_200_000))?.credentials[0]?.rotatesInMs).toBe(0);
	expect(
		await readAuthBrokerSnapshotCache({ ...options, token: "different", ttlMs: 600_000, now: () => 1_040_000 }),
	).toBeNull();
});

test("snapshot bursts persist only their newest tail and unchanged snapshots periodically renew TTL", async () => {
	await using dir = await TempDir.create("@proto-snapshot-queue-");
	const options = { path: dir.join("cache"), token: "secret", url: "https://broker.example" };
	const read = () => readAuthBrokerSnapshotCache({ ...options, ttlMs: 1_000_000, now: () => 1_061_000 });
	scheduleAuthBrokerSnapshotCacheWrite({ ...options, snapshot: snapshot(1, 1_000_000) });
	await flushAuthBrokerSnapshotCacheWrites();
	scheduleAuthBrokerSnapshotCacheWrite({ ...options, snapshot: snapshot(2, 1_000_500) });
	scheduleAuthBrokerSnapshotCacheWrite({ ...options, snapshot: snapshot(3, 1_000_900) });
	await flushAuthBrokerSnapshotCacheWrites();
	expect((await read())?.generation).toBe(3);
	scheduleAuthBrokerSnapshotCacheWrite({ ...options, snapshot: snapshot(3, 1_001_000) });
	await flushAuthBrokerSnapshotCacheWrites();
	expect((await read())?.generatedAt).toBe(1_000_900);
	scheduleAuthBrokerSnapshotCacheWrite({ ...options, snapshot: snapshot(3, 1_061_000) });
	await flushAuthBrokerSnapshotCacheWrites();
	expect((await read())?.generatedAt).toBe(1_061_000);
});
