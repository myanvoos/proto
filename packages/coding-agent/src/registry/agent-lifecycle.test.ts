import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../session/agent-session";
import { getSessionLivePath } from "../session/session-liveness";
import { AgentLifecycleManager } from "./agent-lifecycle";
import { type AgentRef, AgentRegistry } from "./agent-registry";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "proto-lifecycle-"));
}

function writeLiveMarker(sessionFile: string, streaming: boolean, pid: number): void {
	fs.writeFileSync(getSessionLivePath(sessionFile), JSON.stringify({ pid, streaming, at: Date.now() }), {
		encoding: "utf8",
		mode: 0o600,
	});
}

function registerParked(registry: AgentRegistry, sessionFile: string): AgentRef {
	return registry.register({
		id: "worker",
		label: "worker",
		kind: "sub",
		session: null,
		sessionFile,
		status: "parked",
	});
}

afterEach(() => {
	AgentLifecycleManager.resetGlobalForTests();
});

describe("revival failure", () => {
	function fakeSession(disposed: { count: number }): AgentSession {
		return {
			dispose: async () => {
				disposed.count++;
			},
		} as unknown as AgentSession;
	}

	test("a reviver that fails after attaching leaves the ref reusable", async () => {
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "worker.jsonl");
		fs.writeFileSync(sessionFile, "", { encoding: "utf8" });
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		registerParked(registry, sessionFile);

		const disposed = { count: 0 };
		let attempt = 0;
		const healthy = fakeSession(disposed);
		lifecycle.setPersistedSubagentReviverFactory(
			() =>
				Promise.resolve(async target => {
					attempt++;
					if (attempt === 1) {
						// Mirror createAgentSession: attach and mark running, then fail while wiring the rest.
						const broken = fakeSession(disposed);
						registry.attachSession("worker", broken, target.sessionFile, target);
						registry.setStatus("worker", "running", target);
						throw new Error("extension init failed");
					}
					return healthy;
				}),
			60_000,
		);

		await expect(lifecycle.ensureLive("worker")).rejects.toThrow("extension init failed");
		expect(registry.get("worker")?.session).toBeNull();
		expect(registry.get("worker")?.status).toBe("parked");
		expect(disposed.count).toBe(1);

		// The second wake must actually retry rather than hand back the broken session.
		expect(await lifecycle.ensureLive("worker")).toBe(healthy);
		expect(attempt).toBe(2);
		await lifecycle.dispose();
	});
});

describe("idle auto-park", () => {
	function registerIdle(registry: AgentRegistry, id: string, kind: "sub" | "side"): AgentSession {
		const session = { dispose: async () => {} } as unknown as AgentSession;
		registry.register({ id, label: id, kind, session, sessionFile: null, status: "idle" });
		return session;
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	test("focusing an idle subagent holds it live until focus moves on", async () => {
		vi.useFakeTimers();
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const session = registerIdle(registry, "worker", "sub");
		lifecycle.adopt("worker", { idleTtlMs: 30_000 });

		lifecycle.holdForFocus("worker");
		// The realistic sequence: you focus a worker mid-turn, it finishes, and going idle is what
		// re-arms the reclaim timer underneath you.
		registry.setStatus("worker", "running", session);
		registry.setStatus("worker", "idle", session);
		vi.advanceTimersByTime(120_000);
		expect(registry.get("worker")).toMatchObject({ status: "idle", session });

		// Releasing focus re-arms the timer rather than leaving the agent pinned forever.
		lifecycle.holdForFocus(undefined);
		vi.advanceTimersByTime(30_001);

		await lifecycle.park("worker");
		expect(registry.get("worker")).toMatchObject({ status: "parked", session: null });

		vi.useRealTimers();
		await lifecycle.dispose();
	});

	test("an idle subagent parks once its TTL elapses but a side agent stays live", async () => {
		vi.useFakeTimers();
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		registerIdle(registry, "worker", "sub");
		const sideSession = registerIdle(registry, "Side-1", "side");
		lifecycle.adopt("worker", { idleTtlMs: 30_000 });
		lifecycle.adopt("Side-1", { idleTtlMs: 30_000 });

		vi.advanceTimersByTime(30_001);
		await lifecycle.park("worker");

		expect(registry.get("worker")).toMatchObject({ status: "parked", session: null });
		expect(registry.get("Side-1")).toMatchObject({ status: "idle", session: sideSession });
		expect(lifecycle.isParking("Side-1")).toBe(false);

		vi.useRealTimers();
		await lifecycle.dispose();
	});
});

describe("reclaimDeadCorpse", () => {
	test("refuses a parked ref whose transcript has a fresh live marker", async () => {
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "worker.jsonl");
		fs.writeFileSync(sessionFile, "", { encoding: "utf8" });
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const ref = registerParked(registry, sessionFile);
		writeLiveMarker(sessionFile, true, process.pid);

		expect(await lifecycle.reclaimDeadCorpse("worker", ref)).toBe(false);
		expect(registry.get("worker")).toBe(ref);
		await lifecycle.dispose();
	});

	test("reclaims an abandoned parked ref and leaves the transcript on disk", async () => {
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "worker.jsonl");
		fs.writeFileSync(sessionFile, "", { encoding: "utf8" });
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const ref = registerParked(registry, sessionFile);
		writeLiveMarker(sessionFile, true, process.pid);
		const stale = Date.now() - 60_000;
		fs.utimesSync(getSessionLivePath(sessionFile), new Date(stale), new Date(stale));

		expect(await lifecycle.reclaimDeadCorpse("worker", ref)).toBe(true);
		expect(registry.get("worker")).toBeUndefined();
		expect(fs.existsSync(sessionFile)).toBe(true);
		await lifecycle.dispose();
	});

	test("refuses when the ref has no live marker but is still owned elsewhere in the lifecycle", async () => {
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "worker.jsonl");
		fs.writeFileSync(sessionFile, "", { encoding: "utf8" });
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const ref = registerParked(registry, sessionFile);
		lifecycle.adopt("worker", { idleTtlMs: 0 });

		expect(await lifecycle.reclaimDeadCorpse("worker", ref)).toBe(false);
		expect(registry.get("worker")).toBe(ref);
		await lifecycle.dispose();
	});

	test("releases adopted revive handles when a ref becomes aborted", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const ref = registry.register({
			id: "worker",
			label: "worker",
			kind: "sub",
			session: null,
			status: "parked",
		});
		lifecycle.adopt("worker", {
			idleTtlMs: 0,
			revive: async () => {
				throw new Error("unused");
			},
		});
		expect(lifecycle.has("worker", ref)).toBe(true);
		expect(registry.setStatus("worker", "idle", ref)).toBe(true);
		expect(lifecycle.has("worker", ref)).toBe(true);

		expect(registry.setStatus("worker", "aborted", ref)).toBe(true);
		expect(lifecycle.has("worker", ref)).toBe(false);
		expect(registry.get("worker")).toBe(ref);
		await lifecycle.dispose();
	});
});

describe("parking", () => {
	test("resumes a parked worker through its run-local reviver ahead of the persisted factory", async () => {
		const dir = makeTempDir();
		const sessionFile = path.join(dir, "worker.jsonl");
		fs.writeFileSync(sessionFile, "", { encoding: "utf8" });
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		let disposed = false;
		const originalSession = {
			dispose: async () => {
				disposed = true;
			},
		} as unknown as AgentSession;
		const revivedSession = { dispose: async () => {} } as unknown as AgentSession;
		const ref = registry.register({
			id: "worker",
			label: "worker",
			kind: "sub",
			session: originalSession,
			sessionFile,
			status: "idle",
		});
		let runLocalRevives = 0;
		let persistedFactories = 0;
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			persistedFactories++;
			return async () => revivedSession;
		}, 0);
		lifecycle.adopt(
			"worker",
			{
				idleTtlMs: 0,
				revive: async () => {
					runLocalRevives++;
					return revivedSession;
				},
			},
			ref,
		);

		await lifecycle.park("worker");
		expect(disposed).toBe(true);
		expect(ref.session).toBeNull();
		expect(ref.status).toBe("parked");

		expect(await lifecycle.ensureLive("worker")).toBe(revivedSession);
		expect(runLocalRevives).toBe(1);
		expect(persistedFactories).toBe(0);
		expect(ref.session).toBe(revivedSession);
		expect(ref.status).toBe("idle");
		await lifecycle.dispose();
	});
});

describe("fleet-scoped disposal", () => {
	test("releasing one detached main fleet leaves another fleet live", async () => {
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		const disposed: string[] = [];
		const register = (id: string, fleetRoot: string): AgentRef =>
			registry.register({
				id,
				label: id,
				kind: "sub",
				fleetRoot,
				status: "idle",
				session: {
					dispose: async () => {
						disposed.push(id);
					},
				} as unknown as AgentSession,
			});
		const workerA = register("worker-a", "/session-a/fleet");
		const workerB = register("worker-b", "/session-b/fleet");
		lifecycle.adopt(workerA.id, { idleTtlMs: 0 }, workerA);
		lifecycle.adopt(workerB.id, { idleTtlMs: 0 }, workerB);

		await lifecycle.disposeFleet("/session-a/fleet");

		expect(disposed).toEqual(["worker-a"]);
		expect(registry.get("worker-a")).toBeUndefined();
		expect(registry.get("worker-b")).toBe(workerB);
		expect(lifecycle.has("worker-b", workerB)).toBe(true);
		await lifecycle.dispose();
		expect(disposed).toEqual(["worker-a", "worker-b"]);
	});
});
