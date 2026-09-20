import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import { SessionObserverRegistry } from "../session-observer-registry";
import { initThemeSync } from "../theme/theme";
import { type AgentFleetDeps, AgentFleetOverlayComponent } from "./agent-fleet";

const ANSI = /\x1b\[[0-9;]*m/g;
const SHIFT_DOWN = "\x1b[1;2B";
const SHIFT_UP = "\x1b[1;2A";
const ESC = "\x1b";
let closed = 0;

const mounted: Array<{ dispose(): void }> = [];

beforeEach(() => {
	closed = 0;
	initThemeSync();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	for (const view of mounted.splice(0)) view.dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

function renderPlain(fleet: AgentFleetOverlayComponent): string {
	return fleet.render(110).join("\n").replace(ANSI, "");
}

function mountFleet(): AgentFleetOverlayComponent {
	const registry = AgentRegistry.global();
	for (const id of ["agent-1", "agent-2", "agent-3"]) {
		registry.register({ id, label: id, kind: "sub", session: null, status: "idle" });
	}
	const fleet = new AgentFleetOverlayComponent({
		observers: new SessionObserverRegistry(),
		fleetKeys: [],
		onDone: () => {
			closed++;
		},
		requestRender: () => {},
		registry,
		lifecycle: AgentLifecycleManager.global(),
		irc: IrcBus.global(),
	} as AgentFleetDeps);
	mounted.push(fleet);
	return fleet;
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

describe("agent fleet shift-range selection", () => {
	test("shift+down marks a range and x kills every marked agent; plain movement collapses", async () => {
		const fleet = mountFleet();
		expect(renderPlain(fleet)).toContain("agent-1");

		fleet.handleInput(SHIFT_DOWN);
		fleet.handleInput(SHIFT_DOWN);
		// the span is anchor..cursor inclusive: the two anchor-side rows carry the checkbox,
		// the cursor row keeps its cursor glyph, and the chrome announces the count
		const marked = renderPlain(fleet);
		expect(marked.match(/■/g)?.length).toBe(2);
		expect(marked).toContain("Agent Fleet · 3 selected");
		expect(marked).toContain("x:kill 3");

		// Esc drops the range without closing the overlay
		fleet.handleInput(ESC);
		expect(renderPlain(fleet).match(/■/g)).toBeNull();
		expect(renderPlain(fleet)).not.toContain("3 selected");
		expect(closed).toBe(0);

		fleet.handleInput("j");
		expect(renderPlain(fleet).match(/■/g)).toBeNull();

		// re-extend upward from the tail (anchor sits at the cursor) and mass-kill
		fleet.handleInput(SHIFT_UP);
		fleet.handleInput(SHIFT_UP);
		expect(renderPlain(fleet).match(/■/g)?.length).toBe(2);

		fleet.handleInput("x");
		const registry = AgentRegistry.global();
		await waitFor(
			() =>
				registry.get("agent-1")?.status === "aborted" &&
				registry.get("agent-2")?.status === "aborted" &&
				registry.get("agent-3")?.status === "aborted",
			"all three agents to be killed",
		);
		expect(renderPlain(fleet).match(/■/g)).toBeNull(); // executing clears the range

		// selection still extends after the kill: walk to the tail and shift+up over the last two rows
		fleet.handleInput("j");
		fleet.handleInput("j");
		fleet.handleInput(SHIFT_UP);
		expect(renderPlain(fleet).match(/■/g)?.length).toBe(1);
	});

	test("advisors inside a range are skipped by the mass kill", async () => {
		const fleet = mountFleet();
		AgentRegistry.global().register({
			id: "advisor-1",
			label: "advisor",
			kind: "advisor",
			session: null,
			status: "idle",
		});

		fleet.handleInput(SHIFT_DOWN);
		fleet.handleInput(SHIFT_DOWN);
		fleet.handleInput(SHIFT_DOWN);
		fleet.handleInput("x");
		const registry = AgentRegistry.global();
		await waitFor(
			() =>
				registry.get("agent-1")?.status === "aborted" &&
				registry.get("agent-2")?.status === "aborted" &&
				registry.get("agent-3")?.status === "aborted",
			"the three agents to be killed",
		);
		expect(registry.get("advisor-1")?.status).not.toBe("aborted");
	});
});
