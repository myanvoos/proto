import { afterEach, expect, test, vi } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { SessionTreeNode } from "../../session/session-entries";
import type { SessionInfo } from "../../session/session-listing";
import { readToolRenderer } from "../../tools/read-renderer";
import * as open from "../../utils/open";
import { initThemeSync, theme } from "../theme/theme";
import { ErrorBannerComponent } from "./error-banner";
import { HookSelectorComponent } from "./hook-selector";
import { LoginDialogComponent } from "./login-dialog";
import { LogoutAccountSelectorComponent } from "./logout-account-selector";
import { SessionSelectorComponent } from "./session-selector";
import { TreeSelectorComponent } from "./tree-selector";

initThemeSync();
afterEach(() => vi.restoreAllMocks());

function plain(rows: readonly string[]): string {
	return rows.map(row => Bun.stripANSI(row)).join("\n");
}

test("sanitizes pinned error banners and keeps rows within the render width", () => {
	const width = 32;
	const message = `bad\x1b]0;PWN\x07\t${"x".repeat(160)}\nsecond\tline`;
	const rows = new ErrorBannerComponent(message).render(width);

	expect(rows.join("\n")).not.toContain("\x1b]");
	expect(rows.join("\n")).not.toContain("\x07");
	expect(rows.join("\n")).not.toContain("\t");
	expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
	expect(plain(rows)).toContain("bad");
	expect(plain(rows)).toContain("second");
	expect(plain(rows)).toContain("line");
});

test("sanitizes read tool errors and keeps long rows within the render width", () => {
	const width = 32;
	const component = readToolRenderer.renderResult(
		{ isError: true, content: [{ type: "text", text: `bad\x1b]0;PWN\x07\t${"x".repeat(160)}` }] },
		{ expanded: false, isPartial: false },
		theme,
		{ path: "/tmp/read-test.txt" },
	);
	const rows = component.render(width);

	expect(rows.join("\n")).not.toContain("\x1b]");
	expect(rows.join("\n")).not.toContain("\x07");
	expect(rows.join("\n")).not.toContain("\t");
	expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
	expect(plain(rows)).toContain("bad");
});

test("keeps ordinary pinned and read errors unchanged", () => {
	const banner = plain(new ErrorBannerComponent("plain failure").render(40));
	const read = readToolRenderer
		.renderResult(
			{ isError: true, content: [{ type: "text", text: "plain failure" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ path: "/tmp/read-test.txt" },
		)
		.render(40);

	expect(banner).toBe(
		[
			"",
			"────────────────────────────────────────",
			" ✗ plain failure                        ",
			" Dismissed when you send your next      ",
			" message.                               ",
			"────────────────────────────────────────",
		].join("\n"),
	);
	expect(plain(read)).toBe("✗ Read /tmp/read-test.txt\n▏  plain failure");
});

test("sanitizes hook slider labels at the segment-track boundary", () => {
	const selector = new HookSelectorComponent(
		"Choose",
		["one"],
		() => {},
		() => {},
		{
			slider: {
				caption: "Mode",
				index: 0,
				segments: [{ label: "bad\x1b]0;PWN\x07tail", detail: "detail\x1b]0;DETAIL\x07tail" }],
			},
		},
	);
	const rendered = plain(selector.render(100));

	expect(rendered).not.toContain("\x1b]");
	expect(rendered).not.toContain("\x07");
	expect(rendered).toContain("badtail");
	expect(rendered).toContain("detailtail");
});

test("sanitizes every OAuth dialog display field while retaining URL validation", () => {
	const openPath = vi.spyOn(open, "openPath").mockImplementation(() => {});
	const tui = { requestRender: () => {} } as never;
	const url = "https://example.com/login\x1b]0;URL\x07tail";
	const dialog = new LoginDialogComponent(tui, "provider\x1b]0;PROVIDER\x07tail", () => {});
	dialog.showAuth(url, "instructions\x1b]0;INSTRUCTIONS\x07tail", "https://localhost\x1b]0;LOCAL\x07tail");
	const rendered = plain(dialog.render(100));

	expect(openPath).toHaveBeenCalledWith(url);
	expect(rendered).not.toContain("\x1b]");
	expect(rendered).not.toContain("\x07");
	expect(rendered).toContain("Login to providertail");
	expect(rendered).toContain("https://example.com/logintail");
	expect(rendered).toContain("https://localhosttail");
	expect(rendered).toContain("instructionstail");

	const validDialog = new LoginDialogComponent(tui, "provider", () => {});
	validDialog.showAuth("https://example.com/login");
	expect(validDialog.render(100).join("\n")).toContain(
		"\x1b]8;;https://example.com/login\x07Ctrl+click to open\x1b]8;;\x07",
	);
});

test("sanitizes OAuth prompts, placeholders, waiting, and progress messages", () => {
	const tui = { requestRender: () => {} } as never;
	const dialog = new LoginDialogComponent(tui, "provider", () => {});
	void dialog.showPrompt({ message: "message\x1b]0;MESSAGE\x07tail", placeholder: "placeholder\x1b]0;PLACE\x07tail" });
	dialog.showWaiting("waiting\x1b]0;WAIT\x07tail");
	dialog.showProgress("progress\x1b]0;PROGRESS\x07tail");
	const rendered = plain(dialog.render(100));

	expect(rendered).not.toContain("\x1b]");
	expect(rendered).not.toContain("\x07");
	expect(rendered).toContain("messagetail");
	expect(rendered).toContain("e.g., placeholdertail");
	expect(rendered).toContain("waitingtail");
	expect(rendered).toContain("progresstail");
});

function sessionFixture(overrides: Partial<SessionInfo> = {}): SessionInfo {
	const now = new Date(0);
	return {
		path: "/tmp/session.jsonl",
		id: "session",
		cwd: "/home/user/project",
		created: now,
		modified: now,
		messageCount: 1,
		size: 1,
		firstMessage: "first message",
		allMessagesText: "first message",
		...overrides,
	};
}

test("flattens session title and cwd rows and sanitizes delete errors", async () => {
	const session = sessionFixture({ title: "Title\ncontinued", cwd: "/home/user/A\rB" });
	const selector = new SessionSelectorComponent(
		[session],
		() => {},
		() => {},
		() => {},
		{ showCwd: true },
	);
	const rows = selector.render(100).map(row => Bun.stripANSI(row));
	expect(rows.some(row => row.includes("Title continued"))).toBe(true);
	expect(rows.some(row => row.includes("/home/user/A B"))).toBe(true);
	expect(rows.every(row => !row.includes("Title\ncontinued"))).toBe(true);

	const deleting = new SessionSelectorComponent(
		[session],
		() => {},
		() => {},
		() => {},
		{
			onDelete: async () => {
				throw new Error("delete failed\x1b]0;PWN\x07tail");
			},
		},
	);
	deleting.handleInput("\x1b[3~");
	deleting.handleInput("\r");
	await Promise.resolve();
	const afterError = plain(deleting.render(100));
	expect(afterError).not.toContain("\x1b]");
	expect(afterError).not.toContain("\x07");
	expect(afterError).toContain("Error: delete failedtail");
});

test("flattens and sanitizes logout account labels and details", () => {
	const selector = new LogoutAccountSelectorComponent(
		"Provider\nName",
		[
			{
				credentialId: 1,
				provider: "provider",
				label: "Account\nName",
				detail: "detail\rnext",
				type: "oauth",
				active: false,
			},
		],
		() => {},
		() => {},
	);
	const rendered = plain(selector.render(100));

	expect(rendered).toContain("Select Provider Name account to log out");
	expect(rendered).toContain("Account Name  detail next");
	expect(rendered).not.toContain("Account\nName");
});

test("normalizes tree content before its code-point cap and all fallback labels", () => {
	const content = `${"\u009b".repeat(200)}VISIBLE`;
	const userEntry = {
		type: "message",
		id: "user",
		parentId: null,
		timestamp: "",
		message: { role: "user", content },
	};
	const assistantEntry = {
		type: "message",
		id: "assistant",
		parentId: "user",
		timestamp: "",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call",
					name: "custom\x1b]0;NAME\x07tail",
					arguments: { "arg\x1b]0;KEY\x07tail": "value\u009b" },
				},
			],
		},
	};
	const toolEntry = {
		type: "message",
		id: "tool",
		parentId: "assistant",
		timestamp: "",
		message: { role: "toolResult", toolCallId: "call", toolName: "fallback\x1b]0;FALLBACK\x07tail" },
	};
	const roots: SessionTreeNode[] = [
		{ entry: userEntry as never, children: [] },
		{ entry: assistantEntry as never, children: [{ entry: toolEntry as never, children: [] }] },
	];
	const selector = new TreeSelectorComponent(
		roots,
		"tool",
		30,
		() => {},
		() => {},
		undefined,
		"all",
	);
	const rendered = plain(selector.getTreeList().render(120));

	expect(rendered).toContain("VISIBLE");
	expect(rendered).not.toContain("\x1b]");
	expect(rendered).not.toContain("\x07");
	expect(rendered).not.toContain("\u009b");
	expect(rendered).toContain("customtail");
	expect(rendered).toContain("argtail");
});
