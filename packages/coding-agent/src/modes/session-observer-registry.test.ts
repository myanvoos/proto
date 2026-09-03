import { describe, expect, test } from "bun:test";
import {
	CONDUCTOR_SESSION_ID,
	type ObservableSession,
	type SessionObserverChangeKind,
	SessionObserverRegistry,
} from "./session-observer-registry";

function conductorSession(status: ObservableSession["status"] = "active"): ObservableSession {
	return {
		id: CONDUCTOR_SESSION_ID,
		kind: "conductor",
		label: "verifying — fix the flaky auth test",
		agent: "conductor",
		description: "verifying — fix the flaky auth test",
		status,
		lastUpdate: Date.now(),
	};
}

describe("SessionObserverRegistry conductor slot", () => {
	test("upserts the conductor observable and reports it through change listeners", () => {
		const registry = new SessionObserverRegistry();
		const kinds: SessionObserverChangeKind[] = [];
		registry.onChange(kind => kinds.push(kind));

		registry.setConductor(conductorSession());

		const session = registry.getSession(CONDUCTOR_SESSION_ID);
		expect(session?.kind).toBe("conductor");
		expect(session?.status).toBe("active");
		expect(kinds).toContain("progress");
	});

	test("removing the conductor observable is a no-op when none exists, and clears it when it does", () => {
		const registry = new SessionObserverRegistry();

		registry.setConductor(undefined);
		expect(registry.getSession(CONDUCTOR_SESSION_ID)).toBeUndefined();

		registry.setConductor(conductorSession());
		registry.setConductor(undefined);
		expect(registry.getSession(CONDUCTOR_SESSION_ID)).toBeUndefined();
	});

	test("a conductor run never inflates the active subagent count or the subagent HUD filter", () => {
		const registry = new SessionObserverRegistry();
		registry.setConductor(conductorSession("active"));

		expect(registry.getActiveSubagentCount()).toBe(0);
		const hudSessions = registry
			.getSessions()
			.filter(session => session.kind === "subagent" && session.status === "active" && session.detached === true);
		expect(hudSessions).toHaveLength(0);
		// …but it IS listed alongside the main session for the conductor HUD to pick up.
		expect(registry.getSessions().map(session => session.kind)).toContain("conductor");
	});

	test("terminal statuses keep the row so the fleet detail survives, while active filters drop it", () => {
		const registry = new SessionObserverRegistry();
		registry.setConductor(conductorSession("completed"));

		const session = registry.getSession(CONDUCTOR_SESSION_ID);
		expect(session?.status).toBe("completed");
		expect(session?.kind).toBe("conductor");
	});
});
