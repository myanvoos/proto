import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { REMOTE_REFRESH_SENTINEL, type RemoteOAuthCredential } from "../auth-storage";
import type { UsageReport } from "../usage";
import { AuthBrokerClient } from "./client";
import { type AuthBrokerAccountPool, RemoteAuthCredentialStore } from "./remote-store";
import type { SnapshotEntry, SnapshotResponse } from "./types";

function oauth(id: number, provider = "cursor"): SnapshotEntry & { credential: RemoteOAuthCredential } {
	return {
		id,
		provider,
		identityKey: `account-${id}`,
		rotatesInMs: null,
		credential: {
			type: "oauth",
			access: `access-${id}`,
			refresh: REMOTE_REFRESH_SENTINEL,
			expires: 2_000_000_000_000,
			email: `${id}@example.com`,
		},
	};
}
function snapshot(credentials: SnapshotEntry[], generation = 1): SnapshotResponse {
	return {
		generation,
		generatedAt: Date.now(),
		serverNowMs: Date.now(),
		refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
		credentials,
	};
}
function report(provider: string, email?: string): UsageReport {
	return { provider, fetchedAt: Date.now(), limits: [], ...(email ? { metadata: { email } } : {}) };
}
function fixture(
	entries: SnapshotEntry[],
	options: {
		accountPool?: AuthBrokerAccountPool;
		usage?: (provider: string | null) => Promise<UsageReport[]>;
		observed?: (body: unknown) => Promise<Response>;
		observedUsageFlushMs?: number;
	} = {},
) {
	let current = snapshot(entries);
	const requested: (string | null)[] = [];
	const fetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/snapshot") {
				if (!url.searchParams.has("wait")) return Response.json(current);
				const { promise, reject } = Promise.withResolvers<Response>();
				const abort = () => reject(init?.signal?.reason);
				if (init?.signal?.aborted) abort();
				else init?.signal?.addEventListener("abort", abort, { once: true });
				return promise;
			}
			if (url.pathname === "/v1/usage") {
				const provider = url.searchParams.get("provider");
				requested.push(provider);
				return Response.json({ generatedAt: Date.now(), reports: (await options.usage?.(provider)) ?? [] });
			}
			if (url.pathname === "/v1/usage/observed" && options.observed)
				return options.observed(JSON.parse(String(init?.body)));
			return Response.json({ ok: true });
		},
		{ preconnect: fetch.preconnect },
	);
	const client = new AuthBrokerClient({ url: "https://broker.example", token: "secret", fetchImpl, maxRetries: 0 });
	const store = new RemoteAuthCredentialStore({
		client,
		streamSnapshots: false,
		initialSnapshot: current,
		accountPool: options.accountPool,
		observedUsageFlushMs: options.observedUsageFlushMs,
	});
	return {
		store,
		client,
		requested,
		setSnapshot: (entries: SnapshotEntry[], generation = 1) => {
			current = snapshot(entries, generation);
		},
	};
}

test("credential content changes survive repeated broker generations, while order and blocks do not trigger reloads", async () => {
	const f = fixture([oauth(1), oauth(2)]);
	try {
		f.setSnapshot([oauth(2), oauth(1)]);
		await f.store.refreshSnapshot();
		expect(f.store.pollExternalChanges()).toBe(false);
		f.setSnapshot([{ ...oauth(1), credential: { ...oauth(1).credential, access: "rotated" } }, oauth(2)]);
		await f.store.refreshSnapshot();
		expect(f.store.pollExternalChanges()).toBe(true);
		expect(f.store.pollExternalChanges()).toBe(false);
		f.setSnapshot([
			{
				...oauth(1),
				credential: { ...oauth(1).credential, access: "rotated" },
				blocks: [{ providerKey: "cursor", blockScope: "pool:auto", blockedUntilMs: Date.now() + 60_000 }],
			},
			oauth(2),
		]);
		await f.store.refreshSnapshot();
		expect(f.store.pollExternalChanges()).toBe(false);
		f.setSnapshot([oauth(1)], 0);
		await f.store.refreshSnapshot();
		expect(f.store.pollExternalChanges()).toBe(true);
	} finally {
		f.store.close();
	}
});

test("provider allowlists filter OAuth and API keys, inherit wildcard defaults, and copy caller sets", async () => {
	const accounts = new Set(["account-1"]);
	const entries: SnapshotEntry[] = [
		oauth(1),
		oauth(2),
		{
			id: 3,
			provider: "cursor",
			identityKey: null,
			rotatesInMs: null,
			credential: { type: "api_key", key: "hidden" },
		},
		oauth(4, "other"),
		{ id: 5, provider: "zai", identityKey: null, rotatesInMs: null, credential: { type: "api_key", key: "allowed" } },
	];
	const pool: AuthBrokerAccountPool = new Map([
		["*", { accounts: new Set<string>(), apiKeys: false }],
		["cursor", { accounts, apiKeys: false }],
		["zai", { accounts: new Set<string>(), apiKeys: true }],
	]);
	const f = fixture(entries, {
		accountPool: pool,
		usage: async () => [
			report("cursor", "1@example.com"),
			report("cursor", "2@example.com"),
			report("other", "4@example.com"),
			report("zai"),
		],
	});
	try {
		accounts.add("account-2");
		await f.store.refreshSnapshot();
		expect(f.store.listAuthCredentials().map(entry => entry.id)).toEqual([1, 5]);
		expect((await f.store.fetchUsageReports())?.map(value => value.metadata?.email)).toEqual(["1@example.com"]);
	} finally {
		f.store.close();
	}
	const legacy = fixture(entries, { accountPool: new Map([["cursor", new Set<string>()]]) });
	try {
		expect(legacy.store.listAuthCredentials("cursor").map(entry => entry.id)).toEqual([3]);
	} finally {
		legacy.store.close();
	}
});

test("provider usage is single-flight but cannot replace aggregate coverage, including older brokers ignoring its query", async () => {
	const pending = Promise.withResolvers<UsageReport[]>();
	const f = fixture([oauth(1)], {
		usage: provider => (provider === "cursor" ? pending.promise : Promise.resolve([report("cursor"), report("zai")])),
	});
	try {
		const first = f.store.fetchUsageReports(undefined, "cursor");
		const second = f.store.fetchUsageReports(undefined, "cursor");
		pending.resolve([report("cursor"), report("zai")]);
		expect((await first)?.map(value => value.provider)).toEqual(["cursor"]);
		await second;
		expect(f.requested).toEqual(["cursor"]);
		expect((await f.store.fetchUsageReports())?.map(value => value.provider)).toEqual(["cursor", "zai"]);
		expect(f.requested).toEqual(["cursor", null]);
		await f.store.fetchUsageReports(undefined, "zai");
		expect(f.requested).toEqual(["cursor", null]);
	} finally {
		f.store.close();
	}
});

test("closing during an observed-usage send serializes the final batch without dropping newly buffered requests", async () => {
	const firstStarted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<Response>();
	const secondSent = Promise.withResolvers<void>();
	let active = 0;
	let maximum = 0;
	const batches: unknown[] = [];
	const f = fixture([], {
		observedUsageFlushMs: 1,
		observed: async body => {
			active += 1;
			maximum = Math.max(maximum, active);
			batches.push(body);
			try {
				if (batches.length === 1) {
					firstStarted.resolve();
					return await release.promise;
				}
				secondSent.resolve();
				return Response.json({ ok: true });
			} finally {
				active -= 1;
			}
		},
	});
	const entry = {
		at: 1,
		provider: "cursor",
		model: "model",
		requests: 1,
		inputTokens: 12,
		outputTokens: 4,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0.01,
	};
	try {
		f.store.recordObservedUsage([entry], { installId: "test" });
		await firstStarted.promise;
		f.store.recordObservedUsage([entry], { installId: "test" });
		f.store.close();
		release.resolve(Response.json({ ok: true }));
		await secondSent.promise;
		expect(maximum).toBe(1);
		expect(batches).toMatchObject([{ entries: [{ requests: 1 }] }, { entries: [{ requests: 1 }] }]);
	} finally {
		release.resolve(Response.json({ ok: true }));
		f.store.close();
	}
});

test("failed provider usage polls keep their cooldown through snapshot invalidation but never hide newer aggregate coverage", async () => {
	const f = fixture([oauth(1)], {
		usage: async provider => {
			if (provider === "cursor") throw new Error("broker unavailable");
			return [report("cursor"), report("zai")];
		},
	});
	try {
		expect(await f.store.fetchUsageReports(undefined, "cursor")).toBeNull();
		f.setSnapshot([
			{
				...oauth(1),
				blocks: [{ providerKey: "cursor", blockScope: "pool:auto", blockedUntilMs: Date.now() + 60_000 }],
			},
		]);
		await f.store.refreshSnapshot();
		expect(await f.store.fetchUsageReports(undefined, "cursor")).toBeNull();
		expect(f.requested).toEqual(["cursor"]);
		await f.store.fetchUsageReports();
		expect((await f.store.fetchUsageReports(undefined, "cursor"))?.map(value => value.provider)).toEqual(["cursor"]);
		expect(f.requested).toEqual(["cursor", null]);
	} finally {
		f.store.close();
	}
});

test.each([false, true])(
	"a one-shot process flushes usage at exit without stalling on a hung broker (hung=%s)",
	async hung => {
		const observed: unknown[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				if (new URL(request.url).pathname === "/v1/usage/observed") {
					observed.push(await request.json());
					if (hung) return Promise.withResolvers<Response>().promise;
					return Response.json({ ok: true });
				}
				return new Response(null, { status: 503 });
			},
		});
		await using dir = await TempDir.create("@proto-broker-exit-");
		const modulePath = (name: string) => JSON.stringify(path.join(import.meta.dir, name));
		const script = dir.join("exit.ts");
		await Bun.write(
			script,
			`import { AuthBrokerClient } from ${modulePath("client.ts")};
import { RemoteAuthCredentialStore } from ${modulePath("remote-store.ts")};
import * as postmortem from ${JSON.stringify(path.resolve(import.meta.dir, "../../../utils/src/postmortem.ts"))};
const store = new RemoteAuthCredentialStore({client:new AuthBrokerClient({url:${JSON.stringify(server.url.href)},token:"secret",maxRetries:0}),streamSnapshots:false});
store.recordObservedUsage([{at:1,provider:"cursor",model:"model",requests:1,inputTokens:12,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0.01}],{installId:"one-shot",app:"proto"});
await postmortem.quit(0);`,
		);
		try {
			const result = await $`${process.execPath} ${script}`.quiet().nothrow();
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			expect(observed).toMatchObject([
				{ installId: "one-shot", entries: [{ requests: 1, inputTokens: 12, outputTokens: 4 }] },
			]);
		} finally {
			await server.stop(true);
		}
	},
	10_000,
);
