import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-entries";
import { initTheme, theme } from "../theme/theme";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";

await Settings.init();
await initTheme(false, false, "proto");

test("synthetic developer context the model acted on is invisible in the focused transcript", () => {
	const builder = new ChatTranscriptBuilder({
		ui: { requestRender: () => {} } as unknown as TUI,
		requestRender: () => {},
	});
	const entries = [
		{
			message: {
				role: "developer",
				content: "Synthetic developer context\tthe model acted on is visible when expanded.",
				timestamp: 1,
			},
		},
	] as unknown as SessionMessageEntry[];

	try {
		builder.rebuild(entries);
		builder.setExpanded(true);
		const rendered = Bun.stripANSI(builder.container.render(160).join("\n"));
		expect(rendered).toContain("Synthetic developer context");
		expect(rendered).toContain("the model acted on is visible when expanded.");
		expect(rendered).not.toContain("\t");
	} finally {
		builder.dispose();
	}
});

test.each(["tool-only", "trailing-prose"] as const)(
	"replaying an interrupted %s turn shows one dim marker after its final tool",
	tail => {
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender: () => {} } as unknown as TUI,
			requestRender: () => {},
		});
		const interrupted: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo first-tool" } },
				{ type: "text", text: "Between tools." },
				{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "echo final-tool" } },
				...(tail === "trailing-prose" ? [{ type: "text" as const, text: "Partial tail." }] : []),
			],
			api: "openai-completions",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: USER_INTERRUPT_LABEL,
			timestamp: 1,
		};
		try {
			builder.rebuild([
				{
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: new Date(1).toISOString(),
					message: interrupted,
				},
			]);
			const lines = builder.container.render(120);
			const marker = `${theme.symbol("status.aborted")} Interrupted`;
			const markerLines = lines.filter(line => Bun.stripANSI(line).includes(marker));
			expect(markerLines).toHaveLength(1);
			expect(markerLines[0]).toContain(theme.getFgAnsi("dim"));
			expect(markerLines[0]).not.toContain(theme.getFgAnsi("error"));
			const output = Bun.stripANSI(lines.join("\n"));
			expect(output).not.toContain(USER_INTERRUPT_LABEL);
			expect(output).toContain("echo final-tool");
			expect(output.indexOf(marker)).toBeGreaterThan(output.indexOf("echo final-tool"));
			if (tail === "trailing-prose") {
				expect(output).toContain("Partial tail.");
				expect(output.indexOf(marker)).toBeGreaterThan(output.indexOf("Partial tail."));
			}
		} finally {
			builder.dispose();
		}
	},
);
