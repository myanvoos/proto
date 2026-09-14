import { describe, expect, test } from "bun:test";
import type { ToolSession } from "../sdk";
import { applyOpsToPhases, type TodoPhase, TodoTool } from "./todo";

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

test("done acknowledgement names only the completed and next tasks", async () => {
	let current: TodoPhase[] = [
		{
			name: "Phase",
			tasks: [
				{ content: "first task", status: "in_progress" },
				{ content: "second task", status: "pending" },
				{ content: "third task", status: "pending" },
			],
		},
	];
	const session = {
		getTodoPhases: () => current,
		setTodoPhases: (phases: TodoPhase[]) => {
			current = phases;
		},
		getSessionFile: () => undefined,
	} as unknown as ToolSession;
	const result = await new TodoTool(session).execute("call-1", { op: "done", task: "first task" });
	const text = result.content.find(content => content.type === "text")?.text ?? "";

	expect(text).toContain('done "first task"');
	expect(text).toContain("(1/3 done)");
	expect(text).toContain('in progress: "second task"');
	expect(text).not.toContain("third task");
});
