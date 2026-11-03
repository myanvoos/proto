import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentEvent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { CursorTodoSnapshot } from "@oh-my-pi/pi-ai";
import { ShellArgsSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";
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
			parameters: type({ path: "string" }),
			execute: async (_id: string, args: Record<string, unknown>) => {
				paths.push(String((args as { path: string }).path));
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

describe("Cursor native frame contracts", () => {
	it("rejects invalid read arguments before executing the tool", async () => {
		let executed = false;
		const read: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: type({ path: "string", requiredOption: "boolean" }),
			execute: async () => {
				executed = true;
				return { content: [], details: {} };
			},
		};
		const handlers = new CursorExecHandlers({ cwd: "/tmp", tools: new Map([["read", read]]) });
		const result = await handlers.piRead({ toolCallId: "invalid", args: { path: "missing.txt" } });
		expect(result.isError).toBe(true);
		expect(executed).toBe(false);
		expect(result.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("requiredOption") }),
		]);
	});

	it("rejects invalid streaming shell arguments before executing the tool", async () => {
		let executed = false;
		const bash: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Run a command",
			parameters: type({ command: "string", requiredOption: "boolean" }),
			execute: async () => {
				executed = true;
				return { content: [], details: {} };
			},
		};
		const handlers = new CursorExecHandlers({ cwd: "/tmp", tools: new Map([["bash", bash]]) });
		const result = await handlers.shellStream(
			create(ShellArgsSchema, { toolCallId: "stream", command: "true", timeout: 2 }),
			{ onStdout() {}, onStderr() {} },
		);
		expect(result.isError).toBe(true);
		expect(executed).toBe(false);
	});

	it("lists the session's granted alternatives when a native tool is unavailable", async () => {
		const handlers = new CursorExecHandlers({ cwd: "/tmp", tools: new Map([["read", {} as AgentTool]]) });
		const result = await handlers.shell(create(ShellArgsSchema, { toolCallId: "unavailable", command: "true" }));
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining("Use one of: read") })]);
	});

	it("reads local images without raw text selectors while preserving routed URL selectors", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-image-"));
		try {
			await Bun.write(
				path.join(cwd, "pixel.png"),
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
					"base64",
				),
			);
			const paths: string[] = [];
			const read: AgentTool = {
				name: "read",
				label: "Read",
				description: "Read a file",
				parameters: type({ path: "string" }),
				execute: async (_id, args) => {
					paths.push(String((args as { path: string }).path));
					return { content: [], details: {} };
				},
			};
			const handlers = new CursorExecHandlers({ cwd, tools: new Map([["read", read]]) });
			await handlers.read({ toolCallId: "image", path: "pixel.png", offset: 2, limit: 4 });
			await handlers.piRead({ toolCallId: "image-modern", args: { path: "pixel.png" } });
			await handlers.piRead({ toolCallId: "routed", args: { path: "artifact://100", offset: 2, limit: 4 } });
			expect(paths).toEqual(["pixel.png", "pixel.png", "artifact://100:raw:2+4"]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

it("Cursor Shell wait duration does not kill a build early and explicit hard timeout wins", async () => {
	const deadlines: unknown[] = [];
	const parameters = type({ command: "string", "timeout?": "number" });
	const bash: AgentTool<typeof parameters> = {
		name: "bash",
		label: "Bash",
		description: "Run",
		parameters,
		execute: async (_id, args) => {
			deadlines.push(args.timeout);
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	const handlers = new CursorExecHandlers({ cwd: "/tmp", tools: new Map([["bash", bash]]) });
	await handlers.shell(create(ShellArgsSchema, { command: "build", toolCallId: "default", timeout: 5000 }));
	await handlers.shell(
		create(ShellArgsSchema, { command: "build", toolCallId: "hard", timeout: 5000, hardTimeout: 15000 }),
	);
	await handlers.shell(create(ShellArgsSchema, { command: "build", toolCallId: "long", timeout: 420000 }));
	expect(deadlines).toEqual([undefined, 15, 420]);
});
