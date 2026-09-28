import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Markdown } from "@oh-my-pi/pi-tui";
import * as capabilities from "@oh-my-pi/pi-tui/terminal-capabilities";
import { LocalProtocolHandler, resolveLocalRoot } from "../internal-urls/local-protocol";
import { AssistantMessageComponent } from "../modes/components/assistant-message";
import { getMarkdownTheme, initThemeSync } from "../modes/theme/theme";

initThemeSync();

let releaseLocal: () => void;
let previousHyperlinks: boolean;
const sessionOptions = { getArtifactsDir: () => path.resolve("/tmp/proto-link-session") };
const localRoot = resolveLocalRoot(sessionOptions);

beforeEach(() => {
	previousHyperlinks = capabilities.TERMINAL.hyperlinks;
	capabilities.setTerminalHyperlinks(true);
	releaseLocal = LocalProtocolHandler.setOverride(sessionOptions);
});

afterEach(() => {
	releaseLocal();
	capabilities.setTerminalHyperlinks(previousHyperlinks);
});

function targets(output: string): string[] {
	return [...output.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map(match => match[1]!);
}

function fileUri(name: string): string {
	return url.pathToFileURL(path.join(localRoot, name)).href;
}

function render(text: string, width = 120): string {
	return new Markdown(text, 0, 0, getMarkdownTheme()).render(width).join("\n");
}

const message: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 0,
};

test("local links resolve encoded filenames and selectors without exposing expanded paths in the label", () => {
	const output = render("[report](local://reports/Design%20%231.md:12-20)");
	const links = targets(output);
	expect(links.length).toBe(2);
	for (const target of links) {
		const parsed = new URL(target);
		expect(url.fileURLToPath(parsed)).toBe(path.join(localRoot, "reports/Design #1.md"));
		expect(capabilities.TERMINAL.id === "orca" ? parsed.hash : parsed.searchParams.get("line")).toBe(
			capabilities.TERMINAL.id === "orca" ? "#L12" : "12",
		);
	}
	const visible = Bun.stripANSI(output);
	expect(visible).toContain("report");
	expect(visible).toContain("local://reports/Design%20%231.md:12-20");
	expect(visible).not.toContain(localRoot);
});

test("bare local URIs link inside prose and lists without swallowing sentence punctuation", () => {
	const output = render("See local://plan.md.\n\n- Also (local://notes.md), then local://summary.md!");
	expect(targets(output)).toEqual([fileUri("plan.md"), fileUri("notes.md"), fileUri("summary.md")]);
	expect(Bun.stripANSI(output)).toContain("(local://notes.md), then local://summary.md!");
});

test("inline local code links but code blocks and code inside an explicit link do not nest destinations", () => {
	const output = render(
		"`local://plan.md` and [`local://label.md`](https://example.com)\n\n```text\nlocal://sample.md\n```",
	);
	expect(targets(output)).toEqual([fileUri("plan.md"), "https://example.com", "https://example.com"]);
	expect(Bun.stripANSI(output)).toContain("local://sample.md");
});

test("local image links use the same file destination as their visible resource URL", () => {
	const output = render("![diagram](local://diagram.png)");
	expect(targets(output)).toEqual([fileUri("diagram.png"), fileUri("diagram.png")]);
});

test("missing sessions and invalid local paths remain readable without a misleading clickable target", () => {
	expect(targets(render("[bad](local://../secret) `local://%ZZ` local://../secret"))).toEqual([]);
	const releaseMissing = LocalProtocolHandler.setOverride(undefined);
	try {
		const output = render("[plan](local://plan.md) and `local://plan.md` and local://plan.md");
		expect(targets(output)).toEqual([]);
		expect(Bun.stripANSI(output)).toContain("local://plan.md");
	} finally {
		releaseMissing();
	}
});

test("disabling hyperlinks removes OSC destinations from every local Markdown form", () => {
	capabilities.setTerminalHyperlinks(false);
	const output = render("[plan](local://plan.md) `local://plan.md` local://plan.md ![image](local://image.png)");
	expect(targets(output)).toEqual([]);
	expect(Bun.stripANSI(output)).toContain("local://plan.md");
});

test("session changes cannot reuse another session's cached local destinations", () => {
	let artifactsDir = path.resolve("/tmp/session-one");
	const releaseMutable = LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir });
	try {
		const first = new Markdown("local://plan.md", 0, 0, getMarkdownTheme());
		const firstUri = url.pathToFileURL(path.join(artifactsDir, "local/plan.md")).href;
		expect(targets(first.render(80).join("\n"))).toEqual([firstUri]);
		artifactsDir = path.resolve("/tmp/session-two");
		expect(targets(render("local://plan.md"))).toEqual([
			url.pathToFileURL(path.join(artifactsDir, "local/plan.md")).href,
		]);
		// Force the earlier component to rerender rather than merely accepting its cache.
		first.setText("local://plan.md still belongs to session one.");
		expect(targets(first.render(80).join("\n"))).toEqual([firstUri]);
	} finally {
		releaseMutable();
	}
});

test("assistant streaming and rebuilt transcripts preserve local link targets across wrapping and finalization", () => {
	const text = "[plan](local://plan.md)\n\n- Read `local://notes.md`.\n\nThen local://summary.md for details.";
	const reply = new AssistantMessageComponent(undefined, false);
	for (let end = 1; end <= text.length; end++) {
		reply.updateContent({ ...message, content: [{ type: "text", text: text.slice(0, end) }] }, { transient: true });
		reply.render(36);
	}
	const completed = { ...message, content: [{ type: "text" as const, text }] };
	reply.updateContent(completed);
	reply.markTranscriptBlockFinalized();
	const liveTargets = targets(reply.render(36).join("\n"));
	const rebuilt = new AssistantMessageComponent(completed);
	expect(targets(rebuilt.render(36).join("\n"))).toEqual(liveTargets);
	expect(new Set(liveTargets)).toEqual(new Set([fileUri("plan.md"), fileUri("notes.md"), fileUri("summary.md")]));
});
