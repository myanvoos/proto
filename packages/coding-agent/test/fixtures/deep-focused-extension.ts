import * as path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model, type ToolCall } from "@oh-my-pi/pi-ai";
import { AgentRegistry, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { atomicWriteJson } from "@oh-my-pi/pi-utils/atomic-write";
import type { AgentSession } from "../../src/session/agent-session";
import type { FleetDetails } from "../../src/tools/fleet/types";

const root = Bun.env.PROTO_DEEP_FOCUSED_ROOT;
if (!root) throw new Error("PROTO_DEEP_FOCUSED_ROOT is required for the isolated deep TUI fixture");
const reportPath = path.join(root, "report.json");
interface FixtureState {
	providerRequests: Array<{ sessionId: string | undefined; model: string; level: number }>;
	compactions: Array<{ sessionId: string; summary: string; fromExtension: boolean; entryId: string }>;
	stages: Stage[];
	sourceSessions: AgentSession[];
	sourceRoot?: AgentSession;
	rootBefore: string;
	treeBeforeFork?: string;
	selected?: { id: string; sessionId: string; label: string };
	independentWorker?: { id: string; parentNodeId: string | undefined; rootId: string | undefined };
}

// A factory reload must not reset this isolated host's observer while it constructs an independent root.
const host = globalThis as typeof globalThis & { __protoDeepFocusedFixture?: FixtureState };
host.__protoDeepFocusedFixture ??= {
	providerRequests: [],
	compactions: [],
	stages: [],
	sourceSessions: [],
	rootBefore: "",
};
const state = host.__protoDeepFocusedFixture;
const { providerRequests, compactions, stages, sourceSessions } = state;

interface Stage {
	phase: string;
	hasUI: boolean;
	mode: string;
	depth: number;
	sessionId: string;
	nodeId: string;
	rootId: string;
	rootUnchanged: boolean;
	sourceTreeUnchanged: boolean;
	worker?: { id: string; parentNodeId: string | undefined; rootId: string | undefined };
}

const usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sessionFor(ctx: ExtensionContext): AgentSession {
	const sessionId = ctx.sessionManager.getSessionId();
	const session = AgentRegistry.global()
		.list()
		.find(ref => ref.session?.sessionManager.getSessionId() === sessionId)?.session;
	if (!session)
		throw new Error(
			`No real registered session for ${sessionId}: ${JSON.stringify(
				AgentRegistry.global()
					.list()
					.map(ref => ({ id: ref.id, nodeId: ref.nodeId, liveSessionId: ref.session?.sessionId })),
			)}`,
		);
	return session;
}

function rootState(): string {
	if (!state.sourceRoot) throw new Error("Fixture has no source root");
	return JSON.stringify({
		model: state.sourceRoot.model?.id,
		entries: state.sourceRoot.sessionManager.getEntries(),
		topology: state.sourceRoot.sessionManager.getNodeTopology(),
	});
}

function treeState(): string {
	return JSON.stringify(
		sourceSessions.map(session => ({
			id: session.sessionId,
			leaf: session.sessionManager.getLeafId(),
			topology: session.sessionManager.getNodeTopology(),
			entries: session.sessionManager.getEntries(),
		})),
	);
}

async function saveReport(): Promise<void> {
	await atomicWriteJson(reportPath, {
		selected: state.selected,
		rootSessionId: state.sourceRoot?.sessionId,
		rootNodeId: state.sourceRoot?.sessionManager.getNodeTopology()?.id,
		stages,
		compactions,
		providerRequests,
	});
}

async function spawn(parent: AgentSession, level: number, label: string): Promise<AgentSession> {
	const fleet = parent.getToolForEvalBridge("fleet");
	if (!fleet) throw new Error(`No real fleet tool on ${parent.sessionId}`);
	const result = await fleet.execute(`deep-spawn-${level}`, {
		op: "spawn",
		agent: "worker",
		label,
		model: "p1-deep/child",
		message: `DEEP_LEVEL_${level} ${"isolated history payload ".repeat(1200)}`,
	});
	const details = result.details as FleetDetails | undefined;
	const id = details?.spawned?.id;
	if (result.isError || !id) throw new Error(`Real fleet spawn failed: ${JSON.stringify(result)}`);
	await parent.settleAsyncWork();
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`Real worker ${id} did not retain its runtime`);
	await session.waitForIdle();
	return session;
}

function depthOf(session: AgentSession): number {
	let node = session.sessionManager.getNodeTopology();
	let depth = 0;
	const seen = new Set<string>();
	while (node?.parentId) {
		if (seen.has(node.id)) throw new Error("Fixture encountered an ownership cycle");
		seen.add(node.id);
		depth++;
		const parent = sourceSessions.find(
			candidate => candidate.sessionManager.getNodeTopology()?.id === node?.parentId,
		);
		if (!parent) throw new Error(`Missing durable parent ${node.parentId}`);
		node = parent.sessionManager.getNodeTopology();
	}
	return depth;
}

async function recordStage(ctx: ExtensionContext, phase: string): Promise<Stage> {
	const session = sessionFor(ctx);
	const node = session.sessionManager.getNodeTopology();
	if (!node) throw new Error("Selected session has no durable node topology");
	if (phase === "beforefork") state.treeBeforeFork = treeState();
	const stage: Stage = {
		phase,
		hasUI: ctx.hasUI,
		mode: ctx.mode,
		depth: depthOf(session),
		sessionId: session.sessionId,
		nodeId: node.id,
		rootId: node.rootId,
		rootUnchanged: rootState() === state.rootBefore,
		sourceTreeUnchanged: state.treeBeforeFork === undefined || treeState() === state.treeBeforeFork,
		...(phase === "independent" ? { worker: state.independentWorker } : {}),
	};
	stages.push(stage);
	await saveReport();
	ctx.ui.notify(`DEEP_PROOF_${phase}_DEPTH_${stage.depth}`, "info");
	if (!stage.rootUnchanged || !stage.sourceTreeUnchanged) throw new Error(`History ownership changed in ${phase}`);
	return stage;
}

function assistant(model: Model, content: AssistantMessage["content"], toolUse: boolean): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		usage,
		stopReason: toolUse ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

export default function deepFocusedExtension(api: ExtensionAPI): void {
	api.registerProvider("p1-deep", {
		api: "p1-deep-api",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "isolated-offline-fixture-key",
		models: [
			{
				id: "root",
				name: "P1 root only",
				reasoning: false,
				contextWindow: 128000,
				maxTokens: 4096,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "child",
				name: "P1 focused child",
				reasoning: false,
				contextWindow: 128000,
				maxTokens: 4096,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		streamSimple: (model, context, options) => {
			const level = Number(/DEEP_LEVEL_(\d+)/.exec(JSON.stringify(context.messages))?.[1] ?? 0);
			providerRequests.push({ sessionId: options?.sessionId, model: model.id, level });
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				if (context.tools?.some(tool => tool.name === "yield")) {
					const tool: ToolCall = {
						type: "toolCall",
						id: `deep-yield-${providerRequests.length}`,
						name: "yield",
						arguments: { result: { data: `DEEP_RESULT_${level}` } },
					};
					const message = assistant(model, [tool], true);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(tool.arguments),
						partial: message,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tool, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else {
					const message = assistant(model, [{ type: "text", text: `DEEP_IDLE_${level}` }], false);
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: `DEEP_IDLE_${level}`, partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: `DEEP_IDLE_${level}`, partial: message });
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		},
	});
	api.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.notify("DEEP_FIXTURE_READY", "info");
	});
	api.on("session_before_compact", async (event, ctx) => ({
		compaction: {
			summary: "DEPTH3_COMPACT_SUMMARY",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: { selectedSessionId: ctx.sessionManager.getSessionId() },
		},
	}));
	api.on("session_compact", async (event, ctx) => {
		compactions.push({
			sessionId: ctx.sessionManager.getSessionId(),
			summary: event.compactionEntry.summary,
			fromExtension: event.fromExtension,
			entryId: event.compactionEntry.id,
		});
		await saveReport();
	});
	api.registerCommand("deep-setup", {
		scope: "root",
		handler: async (_args, ctx) => {
			state.sourceRoot = sessionFor(ctx);
			sourceSessions.push(state.sourceRoot);
			let parent = state.sourceRoot;
			for (let level = 1; level <= 3; level++) {
				parent = await spawn(parent, level, `Deep${level}`);
				sourceSessions.push(parent);
			}
			for (const source of sourceSessions.toReversed()) {
				await source.settleAsyncWork();
				await source.waitForStreamingIdle();
			}
			await ctx.waitForIdle();
			state.selected = { id: parent.getAgentId() ?? "", sessionId: parent.sessionId, label: "Deep3" };
			if (!state.selected.id || depthOf(parent) !== 3) throw new Error("The real fleet did not create depth three");
			// Result delivery can resume after this command returns; settle outside its callback before the baseline.
			const settledRoot = state.sourceRoot;
			ctx.setTimeout(() => {
				void (async () => {
					await settledRoot.settleAsyncWork();
					await settledRoot.waitForStreamingIdle();
					state.rootBefore = rootState();
					await saveReport();
					ctx.ui.notify("DEEP_SETUP_READY", "info");
				})().catch(error => ctx.ui.notify(`DEEP_SETUP_FAILED ${String(error)}`, "error"));
			}, 0);
		},
	});
	api.registerCommand("deep-proof", {
		scope: "node",
		handler: async (args, ctx) => {
			await recordStage(ctx, args.trim());
		},
	});
	api.registerCommand("deep-dialog", {
		scope: "node",
		handler: async (_args, ctx) => {
			const accepted = await ctx.ui.confirm("DEEP_MANUAL_DIALOG", ctx.sessionManager.getSessionId());
			if (!accepted) throw new Error("Manual focused dialog was not accepted");
			await recordStage(ctx, "dialog");
		},
	});
	api.registerCommand("deep-independent", {
		scope: "node",
		handler: async (_args, ctx) => {
			const session = sessionFor(ctx);
			if (depthOf(session) !== 0 || session === state.sourceRoot)
				throw new Error("Independent spawn requires the newly forked root");
			const worker = await spawn(session, 1, "ForkOwned");
			const node = worker.sessionManager.getNodeTopology();
			if (!node) throw new Error("Independent worker has no durable topology");
			state.independentWorker = { id: node.id, parentNodeId: node.parentId, rootId: node.rootId };
			await recordStage(ctx, "independent");
		},
	});
}
