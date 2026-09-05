import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentMessage, StreamFn } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, type Model, type ToolCall } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AsyncJobManager } from "../async/job-manager";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { getBundledAgent } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import type { ToolSession } from "../tools";
import { EvalTool } from "../tools/eval";
import { OrchestratorRuntime } from "./runtime";

const OWNER_PREFIX = `orchestrator-controlled-${process.pid}`;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(
	model: Model,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function pushToolCall(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	model: Model,
	tool: ToolCall,
): void {
	const partial = message(model, [tool], "toolUse");
	stream.push({ type: "start", partial });
	stream.push({ type: "toolcall_start", contentIndex: 0, partial });
	stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(tool.arguments), partial });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial });
	stream.push({ type: "done", reason: "toolUse", message: partial });
}

function controlledProvider(): StreamFn {
	const evaluatedFollowups = new Set<string>();
	return (model, context) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const taskText = JSON.stringify(context.messages);
			const hasToolResult = context.messages.some(message => message.role === "toolResult");
			const followup = taskText.includes("followup") || taskText.includes("revival");
			const followupKey = taskText.includes("worker-a-py-revival")
				? "worker-a-py-revival"
				: taskText.includes("worker-a-py-followup")
					? "worker-a-py-followup"
					: undefined;
			const shouldEvaluate =
				!hasToolResult || (followup && followupKey !== undefined && !evaluatedFollowups.has(followupKey));
			if (shouldEvaluate) {
				if (followupKey) evaluatedFollowups.add(followupKey);
				const language = taskText.includes("-js") ? "js" : "py";
				const worker = taskText.includes("worker-a") ? "a" : "b";
				const code =
					language === "py"
						? followup
							? 'print("CONTEXT", "worker_a_marker" in globals())'
							: worker === "a"
								? 'print("PARENT", "parent_marker" in globals()); worker_a_marker = "a"; print("A", "set")'
								: 'print("PARENT", "parent_marker" in globals()); print("A", "worker_a_marker" in globals())'
						: followup
							? 'console.log("CONTEXT", "workerAMarker" in globalThis)'
							: worker === "a"
								? 'console.log("PARENT", "parent_marker" in globalThis); globalThis.workerAMarker = "a"; console.log("A", "set")'
								: 'console.log("PARENT", "parent_marker" in globalThis); console.log("A", "workerAMarker" in globalThis)';
				pushToolCall(stream, model, call("eval-cell", "controlled_eval", { language, code, timeout: 30 }));
				return;
			}
			const last = context.messages.at(-1) as AgentMessage | undefined;
			pushToolCall(stream, model, call("yield-result", "yield", { result: { data: JSON.stringify(last) } }));
		});
		return stream;
	};
}

function controlledEvalTool(settings: Settings): CustomTool {
	return {
		name: "controlled_eval",
		label: "Controlled Eval",
		description: "Run a deterministic Python or JavaScript kernel cell.",
		parameters: type({ language: type("'py' | 'js'"), code: type("string"), "timeout?": type("number") }),
		strict: true,
		execute: async (toolCallId, params, _onUpdate, context, signal) => {
			const session = {
				cwd: context.sessionManager.getCwd(),
				hasUI: false,
				settings,
				modelRegistry: context.modelRegistry,
				sessionManager: context.sessionManager,
				getSessionFile: () => context.sessionManager.getSessionFile() ?? null,
				getSessionId: () => context.sessionManager.getSessionId(),
				getAsyncJobOwnerId: () => context.sessionManager.getSessionId(),
				getEvalSessionId: () => context.sessionManager.getSessionId(),
				getEvalKernelOwnerId: () => context.sessionManager.getSessionId(),
				getSessionSpawns: () => "*",
			} as unknown as ToolSession;
			return new EvalTool(session).execute(toolCallId, params as never, signal);
		},
	};
}

function parentSession(args: {
	cwd: string;
	file: string;
	manager: AsyncJobManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage: Awaited<ReturnType<typeof discoverAuthStorage>>;
	streamFn: StreamFn;
	customTools: CustomTool[];
	sessionManager: SessionManager;
}): ToolSession {
	return {
		cwd: args.cwd,
		hasUI: false,
		settings: args.settings,
		asyncJobManager: args.manager,
		modelRegistry: args.modelRegistry,
		authStorage: args.authStorage,
		streamFn: args.streamFn,
		customTools: args.customTools,
		sessionManager: args.sessionManager,
		getSessionFile: () => args.file,
		getSessionId: () => "parent-session",
		getAsyncJobOwnerId: () => "parent-session",
		getAgentId: () => "Main",
		getSessionSpawns: () => "*",
		getEvalSessionId: () => "parent-eval",
		getEvalKernelOwnerId: () => `${OWNER_PREFIX}-parent`,
		getArtifactsDir: () => path.dirname(args.file),
		getActiveModelString: () => undefined,
		getModelString: () => undefined,
	} as ToolSession;
}

let cleanupRoot: string | undefined;
afterAll(async () => {
	if (cleanupRoot) await fs.rm(cleanupRoot, { recursive: true, force: true });
	await disposeKernelSessionsByOwner(`${OWNER_PREFIX}-parent`);
	await disposeVmContextsByOwner(`${OWNER_PREFIX}-parent`);
}, 30_000);

test("orchestrator-created workers isolate Python and JS kernels while preserving explicit sharing", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-orchestrator-controlled-"));
	cleanupRoot = root;
	const parentFile = path.join(root, "parent.jsonl");
	const sessionManager = await SessionManager.open(parentFile, undefined, undefined, {
		initialCwd: root,
		suppressBreadcrumb: true,
	});
	const settings = Settings.isolated({ "orchestrator.maxConcurrency": 4, "orchestrator.agentIdleTtlMs": 60_000 });
	const authStorage = await discoverAuthStorage(path.join(root, "auth"));
	authStorage.setRuntimeApiKey("controlled-provider", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const manager = new AsyncJobManager({ retentionMs: 60_000 });
	const streamFn = controlledProvider();
	const session = parentSession({
		cwd: root,
		file: parentFile,
		manager,
		settings,
		modelRegistry,
		authStorage,
		streamFn,
		customTools: [controlledEvalTool(settings)],
		sessionManager,
	});
	const runtime = OrchestratorRuntime.global();
	const agent = { ...getBundledAgent("worker")!, tools: ["controlled_eval", "yield"] } as AgentDefinition;
	const model = buildModel({
		id: "controlled-model",
		name: "Controlled Model",
		api: "openai-completions",
		provider: "controlled-provider",
		baseUrl: "http://127.0.0.1:9",
		contextWindow: 128_000,
		maxTokens: 4_096,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as never);
	expect(model, "bundled deterministic model metadata is available").toBeDefined();
	runtime.setWorkerResolutionForTesting(agent, model!);
	AgentRegistry.resetGlobalForTests();

	const parentEval = new EvalTool(session);
	const parentPy = await parentEval.execute("parent-py", {
		language: "py",
		code: 'parent_marker = "parent"; print("parent-set")',
		timeout: 30,
	});
	const parentJs = await parentEval.execute("parent-js", {
		language: "js",
		code: 'globalThis.parent_marker = "parent"; console.log("parent-set")',
		timeout: 30,
	});
	expect(parentPy.details?.cells?.[0]?.status).toBe("complete");
	expect(parentJs.details?.cells?.[0]?.status).toBe("complete");

	const ids: string[] = [];
	for (const prompt of ["worker-a-py", "worker-b-py", "worker-a-js", "worker-b-js"]) {
		const spawned = await runtime.spawn(session, { agent: "worker", name: "same-label", prompt });
		ids.push(spawned.id);
	}
	await manager.waitForAll();
	const waits = await runtime.wait(session, { sessions: ids, timeoutMs: 1_000 });
	expect(waits.settled).toHaveLength(4);
	const output = waits.settled.map(entry => entry.resultText).join("\n");
	expect(output).toMatch(/PARENT (?:false|False)/);
	expect(output).toMatch(/A (?:false|False)/);
	expect(output).not.toMatch(/PARENT (?:true|True)/);
	expect(output).not.toMatch(/A (?:true|True)/);

	const firstWorker = ids[0];
	const followup = await runtime.send(session, { session: firstWorker, message: "worker-a-py-followup" });
	expect(followup.id).toBe(firstWorker);
	expect(followup.receipt.status).toBe("accepted");
	await manager.waitForAll();
	const followupWait = await runtime.wait(session, { sessions: [firstWorker], timeoutMs: 1_000 });
	expect(followupWait.settled).toHaveLength(1);
	expect(followupWait.settled[0]?.resultText).toMatch(/CONTEXT (?:True|true)/);

	await AgentLifecycleManager.global().park(firstWorker);
	const parked = AgentRegistry.global().get(firstWorker);
	expect(parked?.status).toBe("parked");
	expect(parked?.session).toBeNull();
	const revival = await runtime.send(session, { session: firstWorker, message: "worker-a-py-revival" });
	expect(revival.id).toBe(firstWorker);
	await manager.waitForAll();
	const revivalWait = await runtime.wait(session, { sessions: [firstWorker], timeoutMs: 1_000 });
	expect(revivalWait.settled).toHaveLength(1);
	expect(revivalWait.settled[0]?.resultText).toMatch(/CONTEXT (?:True|true)/);

	for (const id of ids) await runtime.kill(session, id);
	await manager.dispose({ timeoutMs: 1_000 });

	const sharedA = new EvalTool({ ...session, getEvalSessionId: () => "explicit-shared" } as ToolSession);
	const sharedB = new EvalTool({ ...session, getEvalSessionId: () => "explicit-shared" } as ToolSession);
	const first = await sharedA.execute("shared-a", {
		language: "py",
		code: 'shared_marker = "yes"; print("shared-set")',
		timeout: 30,
	});
	const second = await sharedB.execute("shared-b", {
		language: "py",
		code: 'print("SHARED", shared_marker)',
		timeout: 30,
	});
	expect(first.details?.cells?.[0]?.status).toBe("complete");
	expect(String(second.details?.cells?.[0]?.output ?? "")).toContain("SHARED yes");
}, 30_000);
