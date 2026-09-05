import { describe, expect, test } from "bun:test";
import { applyOpsToPhases, type TodoPhase } from "./todo";

const phases: TodoPhase[] = [
	{
		name: "Phase",
		tasks: [
			{ content: "first task", status: "pending" },
			{ content: "closed task", status: "completed" },
		],
	},
];

describe("todo state transitions", () => {
	test("phase start selects its first pending task", () => {
		const result = applyOpsToPhases(phases, [{ op: "start", phase: "Phase" }]);
		expect(result.errors).toEqual([]);
		expect(result.phases[0]?.tasks[0]?.status).toBe("in_progress");
	});

	test("completed tasks cannot be restarted, dropped, or targeted implicitly", () => {
		const result = applyOpsToPhases(phases, [
			{ op: "start", task: "closed task" },
			{ op: "drop", task: "closed task" },
			{ op: "done" },
		]);
		expect(result.phases[0]?.tasks[1]?.status).toBe("completed");
		expect(result.errors).toEqual(['Task "closed task" is already closed', "done requires a task or phase target"]);
	});
});
