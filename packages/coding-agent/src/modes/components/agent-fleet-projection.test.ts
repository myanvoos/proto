import { describe, expect, test } from "bun:test";
import type { AgentRef } from "../../registry/agent-registry";
import { refBelongsToSessionTree } from "./agent-fleet-projection";

function refWith(sessionFile: string | null): Pick<AgentRef, "sessionFile"> {
	return { sessionFile };
}

describe("refBelongsToSessionTree", () => {
	test("keeps refs whose transcript lives inside the session artifacts tree", () => {
		const sessionFile = "/w/.proto/sessions/proj/sess.jsonl";
		expect(refBelongsToSessionTree(refWith("/w/.proto/sessions/proj/sess/worker.jsonl"), sessionFile)).toBe(true);
		expect(refBelongsToSessionTree(refWith("/w/.proto/sessions/proj/sess/w/nested.jsonl"), sessionFile)).toBe(true);
	});

	test("drops refs from other sessions", () => {
		expect(
			refBelongsToSessionTree(
				refWith("/w/.proto/sessions/other/sess2.jsonl/worker.jsonl"),
				"/w/.proto/sessions/proj/sess.jsonl",
			),
		).toBe(false);
		expect(refBelongsToSessionTree(refWith("/w/somewhere/else.jsonl"), "/w/.proto/sessions/proj/sess.jsonl")).toBe(
			false,
		);
	});

	test("in-memory refs belong; unknown host session only keeps in-memory refs", () => {
		expect(refBelongsToSessionTree(refWith(null), "/w/.proto/sessions/proj/sess.jsonl")).toBe(true);
		expect(refBelongsToSessionTree(refWith("/w/.proto/sessions/proj/sess.jsonl/worker.jsonl"), null)).toBe(false);
		expect(refBelongsToSessionTree(refWith(null), null)).toBe(true);
	});
});
