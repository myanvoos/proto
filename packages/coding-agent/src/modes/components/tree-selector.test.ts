import { expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { SessionManager } from "../../session/session-manager";
import { initThemeSync, theme } from "../theme/theme";
import { TreeSelectorComponent } from "./tree-selector";

initThemeSync();
const plain = (lines: readonly string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function fixture() {
	const session = SessionManager.inMemory();
	const users: string[] = [];
	const answers: string[] = [];
	for (let i = 0; i < 18; i++) {
		users.push(session.appendMessage({ role: "user", content: `TURN_${i} fixture`, timestamp: i * 2 }));
		answers.push(
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `ANSWER_${i} static response` }],
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				stopReason: "stop",
				timestamp: i * 2 + 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		);
	}
	return { session, users, answers };
}

test("tree allocates the current selected row before chrome and uses resized page height", async () => {
	const { session, users, answers } = fixture();
	const chosen: string[] = [];
	const selector = new TreeSelectorComponent(
		session.getTree(),
		session.getLeafId(),
		24,
		id => chosen.push(id),
		() => {},
	);
	try {
		for (const width of [20, 30, 40])
			for (const height of [1, 2, 3, 4, 6, 10, 15, 30]) {
				selector.setMaxHeight(height);
				const lines = selector.render(width);
				expect(lines.length).toBeLessThanOrEqual(height);
				expect(lines.some(line => Bun.stripANSI(line).startsWith(theme.boxRound.vertical))).toBe(height >= 3);
				expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
				expect(
					plain(lines)
						.split("\n")
						.find(line => line.includes("›")),
				).toContain("ANSWER_17");
			}
		selector.setMaxHeight(4);
		expect(plain(selector.render(20))).toContain("↵ open Esc back");
		selector.setMaxHeight(3);
		selector.render(30);
		selector.handleInput("\x1b[5~");
		expect(
			plain(selector.render(30))
				.split("\n")
				.find(line => line.includes("›")),
		).toContain("TURN_17");
		selector.handleInput("\r");
		expect(chosen.at(-1)).toBe(users[17]);
		selector.handleInput("\x1b[H");
		expect(plain(selector.render(30))).toContain("TURN_0");
		selector.handleInput("\x1b[F");
		expect(plain(selector.render(30))).toContain("ANSWER_17");
		selector.handleInput("\r");
		expect(chosen.at(-1)).toBe(answers[17]);
	} finally {
		selector.dispose();
		await session.close();
	}
});

test("tree search and filters keep selection visible and Escape clears before cancelling", async () => {
	const { session, users } = fixture();
	let cancelled = 0;
	const chosen: string[] = [];
	const selector = new TreeSelectorComponent(
		session.getTree(),
		session.getLeafId(),
		24,
		id => chosen.push(id),
		() => cancelled++,
	);
	try {
		selector.setMaxHeight(6);
		selector.handleInput("\x1bu");
		expect(plain(selector.render(30))).toContain("TURN_17");
		selector.handleInput("\r");
		expect(chosen.at(-1)).toBe(users[17]);
		selector.handleInput("zzzzzzzz");
		expect(plain(selector.render(30))).toContain("No entries");
		selector.handleInput("\x1b");
		expect(cancelled).toBe(0);
		expect(plain(selector.render(30))).toContain("TURN_17");
		selector.handleInput("\x1bd");
		selector.handleInput("ANSWER_12");
		expect(
			plain(selector.render(30))
				.split("\n")
				.find(line => line.includes("›")),
		).toContain("ANSWER_12");
		selector.handleInput("\x1b");
		selector.handleInput("\x1b");
		expect(cancelled).toBe(1);
	} finally {
		selector.dispose();
		await session.close();
	}
});

test("tree label input survives shrink, saves the selected target, and cancels without mutation", async () => {
	const { session, answers } = fixture();
	const labels: Array<[string, string | undefined]> = [];
	const selector = new TreeSelectorComponent(
		session.getTree(),
		session.getLeafId(),
		24,
		() => {},
		() => {},
		(id, label) => labels.push([id, label]),
	);
	try {
		selector.handleInput("L");
		selector.handleInput("DRAFT");
		for (const height of [1, 2, 3, 4, 6, 10, 24]) {
			selector.setMaxHeight(height);
			const frame = selector.render(20);
			expect(frame.length).toBeLessThanOrEqual(height);
			expect(plain(frame)).toContain("DRAFT");
		}
		selector.setMaxHeight(4);
		expect(plain(selector.render(20))).toContain("↵ save Esc back");
		selector.handleInput("\x1b");
		expect(labels).toEqual([]);
		expect(plain(selector.render(20))).toContain("ANSWER_17");
		selector.handleInput("L");
		selector.handleInput("SAVED");
		selector.handleInput("\r");
		expect(labels).toEqual([[answers[17]!, "SAVED"]]);
		selector.handleInput("\x1bl");
		expect(plain(selector.render(30))).toContain("[SAVED]");
	} finally {
		selector.dispose();
		await session.close();
	}
});
