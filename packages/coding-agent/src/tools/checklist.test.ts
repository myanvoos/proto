import { describe, expect, test } from "bun:test";
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	type TodoPhase,
	TodoTool,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "./todo";

const phases: TodoPhase[] = [
	{
		name: "Phase",
		tasks: [
			{ content: "first task", status: "pending" },
			{ content: "closed task", status: "completed" },
		],
	},
];

function persistedTodoEntry(id: string, restoredPhases: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-09-18T00:00:00.000Z",
		customType: USER_TODO_EDIT_CUSTOM_TYPE,
		data: { phases: restoredPhases },
	};
}

function historicalTodoEntry(id: string, restoredPhases: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-18T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName: "todo",
			content: [{ type: "text", text: "todo updated" }],
			details: { phases: restoredPhases },
			isError: false,
			timestamp: 0,
		},
	};
}

describe("todo restoration", () => {
	test("skips malformed directly persisted phases and restores the preceding valid state", () => {
		const restored = getLatestTodoPhasesFromEntries([
			persistedTodoEntry("valid", phases),
			persistedTodoEntry("malformed", [{ name: "legacy phase" }]),
		]);

		expect(restored).toEqual(phases);
	});

	test("skips malformed todo result details and restores the preceding valid history state", () => {
		const restored = getLatestTodoPhasesFromEntries([
			historicalTodoEntry("valid", phases),
			historicalTodoEntry("malformed", [{ name: "external phase", tasks: "not-an-array" }]),
		]);

		expect(restored).toEqual(phases);
	});
});

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
