import { describe, expect, it } from "bun:test";
import type { AgentEvent } from "@oh-my-pi/pi-agent-core";
import type { CursorTodoSnapshot } from "@oh-my-pi/pi-ai";
import { CursorExecHandlers } from "./cursor";
import type { ChecklistPhase } from "./tools/checklist";

describe("CursorExecHandlers.todoSync", () => {
	function harness(initial: ChecklistPhase[]) {
		let phases = initial;
		const persisted: ChecklistPhase[][] = [];
		const events: AgentEvent[] = [];
		const handlers = new CursorExecHandlers({
			cwd: "/tmp",
			tools: new Map(),
			getChecklistPhases: () => phases,
			setChecklistPhases: next => {
				phases = next;
			},
			persistChecklistPhases: next => {
				persisted.push(next);
			},
			emitEvent: event => {
				events.push(event);
			},
		});
		const publishedPhases = () =>
			events.flatMap(event =>
				event.type === "tool_execution_end"
					? [(event.result.details as { phases?: ChecklistPhase[] } | undefined)?.phases]
					: [],
			);
		return { handlers, persisted, publishedPhases };
	}

	const auth: ChecklistPhase[] = [{ name: "Auth", tasks: [{ content: "oauth", status: "completed" }] }];
	const snapshot: CursorTodoSnapshot = { todos: [{ content: "oauth", status: "completed" }], merged: false };

	it("does not republish or persist an unchanged read snapshot, so a dismissed HUD stays dismissed", () => {
		const h = harness(auth);
		h.handlers.todoSync(snapshot, "read-1", null, "read");
		expect(h.persisted).toEqual([]);
		expect(h.publishedPhases()).toEqual([undefined]);
	});

	it("still mirrors an unchanged update and a read that changes the list", () => {
		const h = harness(auth);
		h.handlers.todoSync(snapshot, "update-1", null, "update");
		h.handlers.todoSync(
			{ todos: [{ content: "oauth", status: "in_progress" }], merged: false },
			"read-2",
			null,
			"read",
		);
		expect(h.persisted).toHaveLength(2);
		expect(h.publishedPhases().at(-1)).toEqual([
			{ name: "Auth", tasks: [{ content: "oauth", status: "in_progress" }] },
		]);
	});
});
