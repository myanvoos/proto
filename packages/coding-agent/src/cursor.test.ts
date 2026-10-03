import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core";
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

describe("CursorExecHandlers native file frames", () => {
	async function tempDir(): Promise<string> {
		return await fs.mkdtemp(path.join(os.tmpdir(), "cursor-exec-"));
	}

	function capturingRead(paths: string[]): AgentTool {
		return {
			name: "read",
			execute: async (_id: string, args: Record<string, unknown>) => {
				paths.push(String(args.path));
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		} as unknown as AgentTool;
	}

	it("resolves negative read offsets from the end of the file into a raw range", async () => {
		const cwd = await tempDir();
		await Bun.write(
			path.join(cwd, "long.txt"),
			`${Array.from({ length: 1000 }, (_, i) => `line${i + 1}`).join("\n")}\n`,
		);
		const paths: string[] = [];
		const handlers = new CursorExecHandlers({ cwd, tools: new Map([["read", capturingRead(paths)]]) });

		await handlers.read({ toolCallId: "legacy", path: "long.txt", offset: -4, limit: 2 } as never);
		await handlers.piRead({ toolCallId: "modern", args: { path: "long.txt", offset: -1 } } as never);
		await handlers.piRead({ toolCallId: "whole", args: { path: "long.txt" } } as never);

		expect(paths).toEqual(["long.txt:raw:997+2", "long.txt:raw:1000-", "long.txt:raw"]);
	});

	it("returns the deleted file size in details, including zero-byte files", async () => {
		const cwd = await tempDir();
		const handlers = new CursorExecHandlers({ cwd, tools: new Map() });
		for (const content of ["café", ""]) {
			const target = path.join(cwd, "size.txt");
			await Bun.write(target, content);
			const result = await handlers.delete({ toolCallId: "delete", path: target } as never);
			expect(result.isError).toBe(false);
			expect(result.details).toEqual({ fileSize: Buffer.byteLength(content) });
			expect(await Bun.file(target).exists()).toBe(false);
		}
	});
});
