import { expect, test } from "bun:test";
import { EDITOR_LIMITS, visibleWidth } from "@oh-my-pi/pi-tui";
import type { SessionTreeNode } from "../../session/session-entries";
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

test("tree searches beyond previews without hydrating history for initial rendering", async () => {
	const session = SessionManager.inMemory();
	const id = session.appendMessage({
		role: "user",
		content: `visible prefix ${"padding ".repeat(200)}buriedneedle`,
		timestamp: 1,
	});
	const tree = session.getTree();
	const node = tree[0]!;
	if (node.entry.type !== "message") throw new Error("expected message fixture");
	node.entry = { ...node.entry, message: { role: "user", content: "visible prefix", timestamp: 1 } };
	let canHydrate = false;
	const chosen: string[] = [];
	const selector = new TreeSelectorComponent(
		tree,
		id,
		24,
		entryId => chosen.push(entryId),
		() => {},
		undefined,
		"default",
		entryId => {
			if (!canHydrate) throw new Error("historical payload accessed while only rendering metadata");
			return session.getEntry(entryId);
		},
	);
	try {
		expect(plain(selector.render(90))).toContain("visible prefix");
		canHydrate = true;
		selector.handleInput("buriedneedle");
		selector.handleInput("\r");
		expect(chosen).toEqual([id]);
		selector.handleInput("\x1b");
		canHydrate = false;
		expect(plain(selector.render(90))).toContain("visible prefix");
		selector.dispose();
		expect(selector.getTreeList().getSelectedNode()).toBeUndefined();
	} finally {
		selector.dispose();
		await session.close();
	}
});

test("lightweight tree tool rows resolve their original command without retaining full argument maps", async () => {
	const session = SessionManager.inMemory();
	session.appendMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: "tree-tool", name: "bash", arguments: { command: "echo durable-tool-command" } },
		],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		stopReason: "toolUse",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	session.appendMessage({
		role: "toolResult",
		toolCallId: "tree-tool",
		toolName: "bash",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 2,
	});
	const selector = new TreeSelectorComponent(
		session.getTreeForDisplay(),
		session.getLeafId(),
		24,
		() => {},
		() => {},
		undefined,
		"default",
		id => session.getEntry(id),
	);
	try {
		expect(plain(selector.render(100))).toContain("durable-tool-command");
	} finally {
		selector.dispose();
		await session.close();
	}
});

test("oversized tree search input leaves the current selection usable and reports rejection", async () => {
	const { session, answers } = fixture();
	const chosen: string[] = [];
	const selector = new TreeSelectorComponent(
		session.getTreeForDisplay(),
		session.getLeafId(),
		24,
		id => chosen.push(id),
		() => {},
	);
	try {
		selector.handleInput("x".repeat(EDITOR_LIMITS.draftBytes + 1));
		expect(plain(selector.render(100))).toContain("input was not inserted");
		selector.handleInput("\r");
		expect(chosen).toEqual([answers[17]!]);
	} finally {
		selector.dispose();
		await session.close();
	}
});

test("agent section focuses side agents and subagents while branch selection still rewinds", () => {
	const { session, users } = fixture();
	const focused: string[] = [];
	const chosen: string[] = [];
	const selector = new TreeSelectorComponent(
		session.getTree(),
		session.getLeafId(),
		30,
		id => chosen.push(id),
		() => {},
		undefined,
		"default",
		undefined,
		[
			{
				id: "Side-1",
				title: "investigate flaky test",
				kindLabel: "side agent",
				status: "running",
				running: true,
				aborted: false,
				model: "gpt-5.6",
			},
			{
				id: "agent-9",
				title: "summarize logs",
				kindLabel: "subagent",
				status: "aborted",
				running: false,
				aborted: true,
			},
		],
		id => focused.push(id),
	);
	try {
		const rendered = plain(selector.render(80));
		expect(rendered).toContain("Agents (Enter to focus)");
		expect(rendered).toContain("investigate flaky test");
		expect(rendered).toContain("summarize logs");

		// Home puts the cursor on the first branch entry; Enter there rewinds, it must not focus.
		selector.handleInput("\x1b[H");
		selector.handleInput("\r");
		expect(focused).toEqual([]);
		expect(chosen.at(-1)).toBe(users[0]);

		// End lands on the last agent row; Enter focuses it.
		selector.handleInput("\x1b[F");
		selector.handleInput("\r");
		expect(focused).toEqual(["agent-9"]);

		// Down from the last agent wraps to the first tree row; End returns to the agents section.
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[F");
		selector.handleInput("\r");
		expect(focused).toEqual(["agent-9", "agent-9"]);

		// Search filters agent rows too.
		selector.handleInput("f");
		selector.handleInput("l");
		selector.handleInput("a");
		selector.handleInput("k");
		const searched = plain(selector.render(80));
		expect(searched).toContain("investigate flaky test");
		expect(searched).not.toContain("summarize logs");
		selector.handleInput("\r");
		expect(focused).toEqual(["agent-9", "agent-9", "Side-1"]);
	} finally {
		selector.dispose();
	}
});

function customMessageSelector(customType: string, content: string, details?: unknown): TreeSelectorComponent {
	const tree: SessionTreeNode[] = [
		{
			entry: {
				type: "custom_message",
				id: "custom-entry",
				parentId: null,
				timestamp: "2026-08-25T00:00:00.000Z",
				customType,
				content,
				details,
				display: true,
			},
			children: [],
		},
	];
	return new TreeSelectorComponent(
		tree,
		"custom-entry",
		60,
		() => {},
		() => {},
	);
}

function renderCustom(customType: string, content: string, details?: unknown): string {
	return plain(customMessageSelector(customType, content, details).render(120));
}

test("advisor rows show the note tagged with advisor name and severity, not the advisory XML", () => {
	const advisory = (note: string) => `<advisory severity="concern">\n${note}\n</advisory>`;
	const named = renderCustom("advisor", advisory("Nitpick."), {
		notes: [{ note: "Nitpick.", severity: "nit", advisor: "sec\tteam\nlead" }],
	});
	expect(named).toContain("advisor (sec team lead, nit): Nitpick.");
	expect(named).not.toContain("<advisory");

	const plainDefault = renderCustom("advisor", advisory("Continue."), {
		notes: [{ note: "Continue.", advisor: "default" }],
	});
	expect(plainDefault).toContain("advisor: Continue.");
	expect(plainDefault).not.toContain("advisor (");
});

test("custom-message rows drop one outer system wrapper and keep nested payload tags", () => {
	expect(renderCustom("checklist-reminder", "<system-reminder>\n2 items still open.\n</system-reminder>")).toContain(
		"[checklist-reminder]: 2 items still open.",
	);
	const quoted = renderCustom(
		"ttsr-interrupt",
		'<system-interrupt rule="coverage > 80%" path="rules/watch>dog.md">\nOutput interrupted.\n</system-interrupt>',
	);
	expect(quoted).toContain("[ttsr-interrupt]: Output interrupted.");
	expect(quoted).not.toContain("coverage > 80%");
	expect(
		renderCustom(
			"async-result",
			"<system-notice>\nResult: <system-reminder>literal</system-reminder>\n</system-notice>",
		),
	).toContain("[async-result]: Result: <system-reminder>literal</system-reminder>");
	expect(renderCustom("async-result", `<system-notice>${" ".repeat(5_000)}`)).toContain(
		"[async-result]: <system-notice>",
	);
});

test("tree search ignores the outer system wrapper of a custom message", () => {
	const search = (query: string) => {
		const selector = customMessageSelector(
			"async-result",
			`<system-notice>\nBackground job completed. ${"detail ".repeat(60)}\n</system-notice>`,
		);
		for (const ch of query) selector.handleInput(ch);
		return plain(selector.render(120));
	};
	expect(search("system-notice")).not.toContain("Background job");
	expect(search("Background")).toContain("Background job");
});

test("rows past the indent cap share one horizontal offset so connectors keep the tree's shape", () => {
	let counter = 0;
	const node = (role: "user" | "assistant", text: string, parent: SessionTreeNode | null): SessionTreeNode => {
		const id = `e${counter++}`;
		const message =
			role === "user"
				? { role: "user" as const, content: text, timestamp: counter }
				: {
						role: "assistant" as const,
						content: [{ type: "text" as const, text }],
						api: "openai-completions" as const,
						provider: "fixture",
						model: "fixture",
						stopReason: "stop" as const,
						timestamp: counter,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
		const created: SessionTreeNode = {
			entry: {
				type: "message",
				id,
				parentId: parent?.entry.id ?? null,
				timestamp: "2026-09-03T00:00:00.000Z",
				message,
			},
			children: [],
		};
		parent?.children.push(created);
		return created;
	};
	// 25 abandoned forks off one spine: at 120 columns the prefix caps well below that depth.
	const root = node("user", "root question", null);
	let leaf = root;
	for (let fork = 0; fork < 25; fork++) {
		node("assistant", `abandoned ${fork}`, leaf);
		leaf = node("user", `follow-up ${fork}`, leaf);
	}
	const selector = new TreeSelectorComponent(
		[root],
		leaf.entry.id,
		30,
		() => {},
		() => {},
	);
	const rows = selector.render(120).map(line => Bun.stripANSI(line));
	const closing = rows.filter(row => row.includes(theme.tree.last)).map(row => row.indexOf(theme.tree.last));
	expect(closing.length).toBeGreaterThan(2);
	for (let i = 1; i < closing.length; i++) expect(closing[i]).toBeLessThan(closing[i - 1]!);
});
