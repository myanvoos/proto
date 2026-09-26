import { expect, test } from "bun:test";
import { Settings } from "../config/settings";
import { initThemeSync, theme } from "../modes/theme/theme";
import { toolRenderers } from "./renderers";

await Settings.init();
initThemeSync();

const WIDTH = 100;

function render(
	result: Parameters<typeof toolRenderers.fleet.renderResult>[0],
	args: unknown,
	expanded = false,
): string {
	return toolRenderers
		.fleet!.renderResult(result, { expanded, isPartial: false }, theme, args)
		.render(WIDTH)
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
}

// A resumed session replays results recorded before fleet became agents-only. Those process and job
// payloads must keep their original cards; collapsing them to one status line hides transcript data.
test("historical fleet process results still render the process card", () => {
	const text = "Started web: ready pid=51234 uptime=1.2s restarts=0";
	const card = render(
		{
			content: [{ type: "text", text }],
			details: {
				op: "start",
				daemon: {
					name: "web",
					id: "d-1",
					state: "ready",
					pid: 51_234,
					createdAt: 0,
					startedAt: 1,
					readyAt: 2,
					restartCount: 0,
					outputBytes: 2048,
					persist: false,
					detached: false,
				},
			},
		},
		{ op: "start", name: "web", application: "bun" },
	);
	expect(card).toContain("web");
	expect(card).toContain("51234");
	expect(card).toContain("ready");
});

test("historical fleet log output survives replay in full", () => {
	const body = Array.from({ length: 40 }, (_, i) => `log line ${i + 1}`).join("\n");
	const args = { op: "logs", name: "api", lines: 40 };
	const result = { content: [{ type: "text", text: body }], details: { op: "logs", state: "ready", cursor: 12 } };
	expect(render(result, args, true)).toContain("log line 40");
});

test("historical fleet job listings render each job, not a single status line", () => {
	const card = render(
		{
			content: [{ type: "text", text: "2 jobs" }],
			details: {
				op: "jobs",
				jobs: [
					{ id: "job_a1", type: "bash", status: "running", label: "bun test", durationMs: 1200 },
					{ id: "mon_b2", type: "monitor", status: "running", label: "watch deploy", durationMs: 800 },
				],
			},
		},
		{ op: "jobs" },
	);
	expect(card).toContain("job_a1");
	expect(card).toContain("mon_b2");
});

test("agent results keep the current fleet rendering", () => {
	const card = render(
		{
			content: [{ type: "text", text: "Delivered to peer-1." }],
			details: { op: "message", to: "peer-1", receipts: [{ to: "peer-1", outcome: "delivered" }] },
		},
		{ op: "message", to: "peer-1", message: "hi" },
	);
	expect(card).not.toContain("log line");
	expect(card.toLowerCase()).toContain("peer-1");
});
