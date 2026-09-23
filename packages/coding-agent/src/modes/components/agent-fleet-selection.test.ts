import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import { SessionObserverRegistry } from "../session-observer-registry";
import { initThemeSync, theme } from "../theme/theme";
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

function mountFleet(
	terminal?: { rows: number },
	agentIds: string[] = ["agent-1", "agent-2", "agent-3"],
	sessionFile: string | null = "/tmp/proto-fleet-test/session.jsonl",
): AgentFleetOverlayComponent {
	const registry = AgentRegistry.global();
	for (const id of agentIds) {
		registry.register({ id, label: id, kind: "sub", session: null, status: "idle" });
	}
	const fleet = new AgentFleetOverlayComponent({
		observers: new SessionObserverRegistry(),
		ui: terminal ? ({ terminal } as TUI) : undefined,
		fleetKeys: [],
		onDone: () => {
			closed++;
		},
		requestRender: () => {},
		registry,
		lifecycle: AgentLifecycleManager.global(),
		irc: IrcBus.global(),
		sessionFile,
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

test("tiny fleet roster keeps selected agent with paired borders or no rails", () => {
	const terminal = { rows: 24 };
	const fleet = mountFleet(terminal);
	fleet.handleInput("j");
	for (const width of [20, 110])
		for (const height of [1, 2, 3, 4]) {
			terminal.rows = height;
			const lines = fleet.render(width).map(line => Bun.stripANSI(line));
			expect(lines.length).toBeLessThanOrEqual(height);
			expect(lines.every(line => Bun.stringWidth(line) <= width)).toBe(true);
			expect(lines.some(line => line.includes("agent-2") && line.includes(theme.nav.cursor))).toBe(true);
			if (height < 3)
				expect(
					lines.some(line => line.startsWith(theme.boxRound.vertical) || line.startsWith(theme.boxRound.topLeft)),
				).toBe(false);
			else {
				expect(lines[0].startsWith(theme.boxRound.topLeft)).toBe(true);
				expect(lines[lines.length - 1].startsWith(theme.boxRound.bottomLeft)).toBe(true);
			}
		}
});

describe("agent fleet empty state", () => {
	test("guidance wraps instead of truncating while rows remain", async () => {
		const fleet = mountFleet({ rows: 24 }, []);
		await waitFor(() => fleet.render(40).join("\n").replace(ANSI, "").includes("No agents"), "empty state");

		for (const width of [100, 80, 60, 40]) {
			const rows = fleet.render(width).map(row => row.replace(ANSI, ""));
			for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);

			// Strip the dialog frame so only the roster column's own text remains.
			const guidance = rows
				.map(row =>
					row
						.replace(/^│/, "")
						.replace(/[│╭╮╰╯├┤┬┴].*$/, "")
						.trim(),
				)
				.filter(row => row.length > 0)
				.join(" ")
				.replace(/\s+/g, " ");

			expect(guidance).toContain("No agents in this session");
			expect(guidance).toContain(
				"Finished, parked, and killed subagents remain with the session that created them.",
			);
			expect(guidance).toContain("Resume that session with proto --continue, or spawn a worker here.");
			// The footer hints legitimately truncate; the guidance block must not.
			const guidanceBlock = guidance.slice(
				guidance.indexOf("No agents"),
				guidance.indexOf("worker here.") + "worker here.".length,
			);
			expect(guidanceBlock).not.toContain("…");
		}
	});

	test("an in-memory session explains why nothing is saved instead of raising an error", async () => {
		const fleet = mountFleet({ rows: 24 }, [], null);
		await waitFor(() => fleet.render(40).join("\n").replace(ANSI, "").includes("No agents"), "empty state");

		for (const width of [100, 80, 60, 40]) {
			const rows = fleet.render(width).map(row => row.replace(ANSI, ""));
			for (const row of rows) expect(row.length).toBeLessThanOrEqual(width);

			const guidance = rows
				.map(row =>
					row
						.replace(/^│/, "")
						.replace(/[│╭╮╰╯├┤┬┴].*$/, "")
						.trim(),
				)
				.filter(row => row.length > 0)
				.join(" ")
				.replace(/\s+/g, " ");

			// The cause names the missing session file, the remedy names both ways out, and
			// neither borrows the resume advice that only applies to a session on disk.
			expect(guidance).toContain("No agents in this in-memory session");
			expect(guidance).toContain("No session file: this session's agents are never saved for later inspection.");
			expect(guidance).toContain("Spawn a worker to watch it live, or restart without --no-session.");
			expect(guidance).not.toContain("proto --continue");
			const guidanceBlock = guidance.slice(
				guidance.indexOf("No agents"),
				guidance.indexOf("--no-session.") + "--no-session.".length,
			);
			expect(guidanceBlock).not.toContain("…");
		}
	});

	test("short panels shed the explanation, then the long remedy, but never a half sentence", async () => {
		const fleet = mountFleet({ rows: 12 }, [], null);
		await waitFor(() => fleet.render(40).join("\n").replace(ANSI, "").includes("No agents"), "empty state");

		const guidanceAt = (width: number): string =>
			fleet
				.render(width)
				.map(row =>
					row
						.replace(ANSI, "")
						.replace(/^│/, "")
						.replace(/[│╭╮╰╯├┤┬┴].*$/, "")
						.trim(),
				)
				.filter(row => row.length > 0)
				.join(" ")
				.replace(/\s+/g, " ");

		// Wide enough for the remedy on one row: the explanation goes, the remedy stays whole.
		const wide = guidanceAt(40);
		expect(wide).toContain("No agents in this in-memory session");
		expect(wide).toContain("Spawn a worker to watch it live, or restart without --no-session.");
		expect(wide).not.toContain("No session file:");

		// Too narrow for that sentence: the short remedy replaces it rather than being cut.
		const narrow = guidanceAt(30);
		expect(narrow).toContain("No agents in this in-memory session");
		expect(narrow).toContain("Restart without --no-session.");
		expect(narrow).not.toContain("Spawn a worker");
	});
});
