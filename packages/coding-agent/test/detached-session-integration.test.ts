import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "bun:test";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { DetachedSessionHolder, detachedSessionHolder } from "@oh-my-pi/pi-coding-agent/session/detached-session-holder";

type MockSession = {
	isStreaming: boolean;
	abort: Mock<(...args: Array<unknown>) => unknown>;
};

type MockManager = {
	id: string;
};

function makeMockSession(isStreaming: boolean): MockSession {
	return { isStreaming, abort: vi.fn() };
}

function makeMockManager(id = "mgr"): MockManager {
	return { id };
}

/**
 * Minimal simulation of the spec's handleResumeSession park/abort branching.
 * This mirrors the contract described in spec-background-continuation:
 * - same file → no park, no abort
 * - null/in-memory/non-jsonl previous file → no park, abort path
 * - isStreaming true + detachedMainSessions true → park previous, toast "Parked"
 * - otherwise → abort, toast "Interrupted" (or none when not streaming)
 */
function simulateHandleResumeSession(opts: {
	previousFile: string | null | undefined;
	targetFile: string;
	isStreaming: boolean;
	detachedMainSessions: boolean;
	session: MockSession;
	manager: MockManager;
	holder: DetachedSessionHolder;
	switchSession: Mock<(...args: Array<unknown>) => unknown>;
	showStatus: Mock<(...args: Array<unknown>) => unknown>;
}): { parked: boolean; toast: string | undefined } {
	const { previousFile, targetFile, isStreaming, detachedMainSessions, session, manager, holder, switchSession, showStatus } =
		opts;

	const previousResolved = previousFile ? path.resolve(previousFile) : undefined;
	const targetResolved = path.resolve(targetFile);

	// Same file → no park/abort, just switch
	if (previousResolved && previousResolved === targetResolved) {
		switchSession(targetFile);
		return { parked: false, toast: undefined };
	}

	// Null/in-memory/non-jsonl → no park, abort if streaming
	if (!previousFile?.endsWith(".jsonl")) {
		if (isStreaming) {
			session.abort({ goalReason: "internal" });
			showStatus("Interrupted");
			switchSession(targetFile);
			return { parked: false, toast: "Interrupted" };
		}
		switchSession(targetFile);
		return { parked: false, toast: undefined };
	}

	if (isStreaming && detachedMainSessions) {
		holder.park(previousFile, session as unknown as AgentSession, manager as unknown as SessionManager);
		showStatus("Parked");
		switchSession(targetFile);
		return { parked: true, toast: "Parked" };
	}

	if (isStreaming) {
		session.abort({ goalReason: "internal" });
		showStatus("Interrupted");
		switchSession(targetFile);
		return { parked: false, toast: "Interrupted" };
	}

	switchSession(targetFile);
	return { parked: false, toast: undefined };
}

describe("detached session integration: park/re-attach simulation", () => {
	beforeEach(() => {
		detachedSessionHolder.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		detachedSessionHolder.clear();
	});

	it("when isStreaming true, different file, detachedMainSessions true parks previous and shows Parked toast not Interrupt", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(true);
		const manager = makeMockManager("m1");
		const previousFile = "/tmp/main-a.jsonl";
		const targetFile = "/tmp/main-b.jsonl";
		const switchSession = vi.fn();
		const showStatus = vi.fn();
		const parkSpy = vi.spyOn(holder, "park");

		const result = simulateHandleResumeSession({
			previousFile,
			targetFile,
			isStreaming: true,
			detachedMainSessions: true,
			session,
			manager,
			holder,
			switchSession,
			showStatus,
		});

		expect(result.parked).toBe(true);
		expect(result.toast).toBe("Parked");
		expect(parkSpy).toHaveBeenCalledWith(previousFile, expect.anything(), expect.anything());
		expect(holder.has(previousFile)).toBe(true);
		expect(session.abort).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Parked");
		expect(showStatus).not.toHaveBeenCalledWith("Interrupted");
		expect(switchSession).toHaveBeenCalledWith(targetFile);
	});

	it("when isStreaming false, shows no toast and does not park, aborts not called", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(false);
		const manager = makeMockManager("m1");
		const previousFile = "/tmp/main-a.jsonl";
		const targetFile = "/tmp/main-b.jsonl";
		const switchSession = vi.fn();
		const showStatus = vi.fn();
		const parkSpy = vi.spyOn(holder, "park");

		const result = simulateHandleResumeSession({
			previousFile,
			targetFile,
			isStreaming: false,
			detachedMainSessions: true,
			session,
			manager,
			holder,
			switchSession,
			showStatus,
		});

		expect(result.parked).toBe(false);
		expect(result.toast).toBeUndefined();
		expect(parkSpy).not.toHaveBeenCalled();
		expect(holder.has(previousFile)).toBe(false);
		expect(session.abort).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(switchSession).toHaveBeenCalledWith(targetFile);
	});

	it("when isStreaming true but detachedMainSessions false, aborts and shows Interrupted", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(true);
		const manager = makeMockManager("m1");
		const previousFile = "/tmp/main-a.jsonl";
		const targetFile = "/tmp/main-b.jsonl";
		const switchSession = vi.fn();
		const showStatus = vi.fn();

		const result = simulateHandleResumeSession({
			previousFile,
			targetFile,
			isStreaming: true,
			detachedMainSessions: false,
			session,
			manager,
			holder,
			switchSession,
			showStatus,
		});

		expect(result.parked).toBe(false);
		expect(result.toast).toBe("Interrupted");
		expect(holder.has(previousFile)).toBe(false);
		expect(session.abort).toHaveBeenCalledWith({ goalReason: "internal" });
		expect(showStatus).toHaveBeenCalledWith("Interrupted");
	});

	it("when target file is same as previous, no park and no abort", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(true);
		const manager = makeMockManager("m1");
		const previousFile = "/tmp/main-a.jsonl";
		const targetFile = "/tmp/main-a.jsonl";
		const switchSession = vi.fn();
		const showStatus = vi.fn();
		const parkSpy = vi.spyOn(holder, "park");

		const result = simulateHandleResumeSession({
			previousFile,
			targetFile,
			isStreaming: true,
			detachedMainSessions: true,
			session,
			manager,
			holder,
			switchSession,
			showStatus,
		});

		expect(result.parked).toBe(false);
		expect(result.toast).toBeUndefined();
		expect(parkSpy).not.toHaveBeenCalled();
		expect(session.abort).not.toHaveBeenCalled();
		expect(holder.size()).toBe(0);
	});

	it("when previousFile is null/in-memory, no park, abort path when streaming", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(true);
		const manager = makeMockManager("m1");
		const switchSession = vi.fn();
		const showStatus = vi.fn();

		for (const previousFile of [null, undefined, "in-memory", "/tmp/foo.txt"] as const) {
			holder.clear();
			session.abort.mockClear();
			showStatus.mockClear();
			const result = simulateHandleResumeSession({
				previousFile,
				targetFile: "/tmp/target.jsonl",
				isStreaming: true,
				detachedMainSessions: true,
				session,
				manager,
				holder,
				switchSession,
				showStatus,
			});
			expect(result.parked).toBe(false);
			expect(holder.size()).toBe(0);
			expect(holder.has(previousFile as string | null)).toBe(false);
			// abort path for streaming with unparkable file
			expect(session.abort).toHaveBeenCalled();
			expect(result.toast).toBe("Interrupted");
			session.abort.mockClear();
		}
	});

	it("when previousFile is null and not streaming, no park and no abort", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(false);
		const manager = makeMockManager("m1");
		const switchSession = vi.fn();
		const showStatus = vi.fn();

		const result = simulateHandleResumeSession({
			previousFile: null,
			targetFile: "/tmp/target.jsonl",
			isStreaming: false,
			detachedMainSessions: true,
			session,
			manager,
			holder,
			switchSession,
			showStatus,
		});

		expect(result.parked).toBe(false);
		expect(result.toast).toBeUndefined();
		expect(holder.size()).toBe(0);
		expect(session.abort).not.toHaveBeenCalled();
	});

	it("re-attach: park A then take A returns same object, manager identity same (spy)", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(true);
		const manager = makeMockManager("mgr-1");
		const file = "/tmp/reattach/session.jsonl";

		holder.park(file, session as unknown as AgentSession, manager as unknown as SessionManager);
		expect(holder.has(file)).toBe(true);
		expect(holder.peek(file)?.session).toBe(session as unknown as AgentSession);
		expect(holder.peek(file)?.manager).toBe(manager as unknown as SessionManager);

		// Simulate re-entering the parked file: take should return same instances
		const taken = holder.take(file);
		expect(taken?.session).toBe(session as unknown as AgentSession);
		expect(taken?.manager).toBe(manager as unknown as SessionManager);
		expect(taken?.manager).toBe(manager as unknown as SessionManager);
		// After take, holder no longer has it
		expect(holder.has(file)).toBe(false);
		expect(holder.size()).toBe(0);

		// Parking again and using singleton via spy shows identity preservation
		const parkSpy = vi.spyOn(detachedSessionHolder, "park");
		const takeSpy = vi.spyOn(detachedSessionHolder, "take");
		const s2 = makeMockSession(false);
		const m2 = makeMockManager("mgr-2");
		detachedSessionHolder.park(file, s2 as unknown as AgentSession, m2 as unknown as SessionManager);
		expect(parkSpy).toHaveBeenCalledWith(file, s2 as unknown as AgentSession, m2 as unknown as SessionManager);
		const taken2 = detachedSessionHolder.take(file);
		expect(takeSpy).toHaveBeenCalledWith(file);
		expect(taken2?.session).toBe(s2 as unknown as AgentSession);
		expect(taken2?.manager).toBe(m2 as unknown as SessionManager);
	});

	it("path.resolve variant re-attach uses same identity", () => {
		const holder = new DetachedSessionHolder();
		const session = makeMockSession(true);
		const manager = makeMockManager("mgr-resolve");
		const canonical = "/a/b/session.jsonl";
		const variant = "/a/../a/b/session.jsonl";

		holder.park(canonical, session as unknown as AgentSession, manager as unknown as SessionManager);
		// Take via variant should return same session/manager
		const taken = holder.take(variant);
		expect(taken?.session).toBe(session as unknown as AgentSession);
		expect(taken?.manager).toBe(manager as unknown as SessionManager);
	});

	it("park then evict preserves newer, re-attach of survivor still identity same", () => {
		const holder = new DetachedSessionHolder();
		const base = Date.now();
		const sOld = makeMockSession(true);
		const sNew = makeMockSession(true);
		const mOld = makeMockManager("old");
		const mNew = makeMockManager("new");

		{
			const spy = vi.spyOn(Date, "now").mockReturnValue(base);
			holder.park("/tmp/evict-integration/old.jsonl", sOld as unknown as AgentSession, mOld as unknown as SessionManager);
			spy.mockRestore();
		}
		{
			const spy = vi.spyOn(Date, "now").mockReturnValue(base + 1000);
			holder.park("/tmp/evict-integration/new.jsonl", sNew as unknown as AgentSession, mNew as unknown as SessionManager);
			spy.mockRestore();
		}

		const evicted = holder.evictLRU(1);
		expect(evicted[0]).toBe(path.resolve("/tmp/evict-integration/old.jsonl"));
		expect(sOld.abort).toHaveBeenCalled();
		// New survives, take returns same identity
		const taken = holder.take("/tmp/evict-integration/new.jsonl");
		expect(taken?.session).toBe(sNew as unknown as AgentSession);
		expect(taken?.manager).toBe(mNew as unknown as SessionManager);
	});
});
