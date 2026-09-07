import { afterEach, expect, test } from "bun:test";
import { type Component, Container, type NativeScrollbackWidthEpoch } from "@oh-my-pi/pi-tui";
import { Settings } from "../config/settings";
import { evalToolRenderer } from "../tools/eval-render";
import type { ToolExecutionHandle } from "./components/tool-execution";
import { ToolExecutionComponent } from "./components/tool-execution";
import { TranscriptContainer } from "./components/transcript-container";
import { initTheme } from "./theme/theme";
import { resolvePreservedLiveToolCallIds, UiHelpers } from "./utils/ui-helpers";

await Settings.init();
await initTheme(false, false, "proto");

afterEach(disposeSpinnerComponents);

const fakeTool: any = {
	name: "kernel",
	label: "Kernel",
	mergeCallAndResult: true,
	renderCall: evalToolRenderer.renderCall,
	renderResult: evalToolRenderer.renderResult,
	intent: (args: any) => args?.title,
};

const CALL_ID = "chatcmpl-tool-inflight-1";
const ARGS = { code: 'print("hi")', title: "inflight" };

const noop = () => {};
const stubUi = { requestRender: noop, requestComponentRender: noop, resetDisplay: noop, imageBudget: undefined };
const spinnerComponents: ToolExecutionComponent[] = [];
function makeLiveComponent(): ToolExecutionComponent {
	const component = new ToolExecutionComponent("kernel", ARGS, { useBuiltInRenderer: true }, fakeTool, stubUi as any);
	spinnerComponents.push(component);
	return component;
}
function disposeSpinnerComponents(): void {
	for (const component of spinnerComponents) component.dispose();
	spinnerComponents.length = 0;
}

function assistantMessageWithCall(): any {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: CALL_ID, name: "kernel", arguments: ARGS }],
		stopReason: "toolUse",
		api: "openai-completions",
		provider: "vllm",
		model: "cento-firefly",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function settledToolResultMessage(): any {
	return {
		role: "toolResult",
		toolCallId: CALL_ID,
		toolName: "kernel",
		content: [{ type: "text", text: "done" }],
		details: { language: "python", languages: ["python"] },
		isError: false,
		timestamp: Date.now(),
	};
}

function makeCtx(chatContainer: TranscriptContainer, pendingTools: Map<string, ToolExecutionHandle>): any {
	const noop = () => {};
	return {
		ui: {
			requestRender: noop,
			requestComponentRender: noop,
			resetDisplay: noop,
			imageBudget: undefined,
			terminal: { setProgress: noop },
		},
		chatContainer,
		pendingTools,
		statusContainer: new Container(),
		settings: { get: (k: string) => k !== "terminal.showImages" },
		sessionManager: { getCwd: () => "/tmp" },
		viewSession: {
			getToolByName: (n: string) => (n === "kernel" ? fakeTool : undefined),
			hasBuiltInTool: (n: string) => n === "kernel",
			isTtsrAbortPending: false,
			isRetrying: false,
			extensionRunner: undefined,
			sessionManager: { getCwd: () => "/tmp" },
			retryAttempt: undefined,
			isStreaming: true,
		},
		toolOutputExpanded: false,
		hideToolActivity: false,
		proseOnlyThinking: false,
		effectiveHideThinkingBlock: false,
		noteDisplayableThinkingContent: () => false,
		transcriptMessageComponents: new WeakMap(),
		statusLine: { invalidate: noop, markActivityEnd: noop, markActivityStart: noop },
		streamingComponent: undefined,
		streamingMessage: undefined,
		loadingAnimation: undefined,
		retryLoader: undefined,
		autoCompactionLoader: undefined,
		addMessageToChat: () => [],
	};
}

function toolComponentsIn(container: TranscriptContainer): ToolExecutionComponent[] {
	return container.children.filter(c => c instanceof ToolExecutionComponent) as ToolExecutionComponent[];
}

class MutableBlock implements Component {
	lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.lines = lines;
	}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class TrackedBlock implements Component {
	#listener?: () => void;
	#version = 0;
	readonly #finalized: boolean;
	notifications = 0;
	lines: readonly string[];

	constructor(lines: readonly string[], finalized = true) {
		this.lines = lines;
		this.#finalized = finalized;
	}

	setTranscriptBlockChangeListener(listener: (() => void) | undefined): void {
		this.#listener = listener;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	getTranscriptBlockVersion(): number {
		return this.#version;
	}

	setLines(lines: readonly string[]): void {
		this.lines = lines;
		this.#version++;
		if (this.#listener) {
			this.notifications++;
			this.#listener();
		}
	}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class ReplayTrackedBlock extends TrackedBlock {
	#replayedLines: readonly string[];

	constructor(lines: readonly string[], replayedLines: readonly string[]) {
		super(lines);
		this.#replayedLines = replayedLines;
	}

	prepareNativeScrollbackReplay(): void {
		this.setLines(this.#replayedLines);
	}
}

class WidthAwareTrackedBlock extends TrackedBlock implements NativeScrollbackWidthEpoch {
	#rows: number;

	constructor(lines: readonly string[]) {
		super(lines);
		this.#rows = lines.length;
	}

	override setLines(lines: readonly string[]): void {
		super.setLines(lines);
		this.#rows = lines.length;
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		return { rows: this.#rows };
	}

	resolveNativeScrollbackWidthEpoch(boundary: unknown): number | undefined {
		if (typeof boundary !== "object" || boundary === null || !("rows" in boundary)) return undefined;
		const rows = (boundary as { rows?: unknown }).rows;
		return typeof rows === "number" ? rows : undefined;
	}

	getNativeScrollbackWidthEpochRows(): number | undefined {
		return this.#rows;
	}

	isNativeScrollbackWidthEpochAppendOnly(_boundary: unknown): boolean {
		return true;
	}
}

test("TranscriptContainer revision tracks rendered content and clear drops old rows", () => {
	const container = new TranscriptContainer();
	const block = new MutableBlock(["before"]);
	container.addChild(block);

	expect(container.render(40)).toEqual(["before"]);
	const initialRevision = container.getRenderRevision();
	expect(container.render(40)).toEqual(["before"]);
	expect(container.getRenderRevision(), "unchanged transcript rows keep a stable revision").toBe(initialRevision);

	block.lines = ["after"];
	container.invalidate();
	expect(container.render(40)).toEqual(["after"]);
	expect(container.getRenderRevision(), "changed transcript rows invalidate the viewer source").toBeGreaterThan(
		initialRevision,
	);

	container.clear();
	expect(container.render(40), "clearing a transcript must not replay rows from the previous session").toEqual([]);
});

test("tracked finalized edits and public child mutations rebuild transcript output", () => {
	const first = new TrackedBlock(["first"]);
	const second = new TrackedBlock(["second"]);
	const live = new TrackedBlock(["live"], false);
	const replacement = new TrackedBlock(["replacement"]);
	const container = new TranscriptContainer();
	container.addChild(first);
	container.addChild(second);
	container.addChild(live);

	expect(container.render(40)).toEqual(["first", "", "second", "", "live"]);

	first.setLines(["edited"]);
	expect(container.render(40), "a subscribed finalized block must invalidate without parent invalidation").toEqual([
		"edited",
		"",
		"second",
		"",
		"live",
	]);

	container.children.reverse();
	expect(container.render(40), "reordering the public children array must invalidate cached prefix rows").toEqual([
		"live",
		"",
		"second",
		"",
		"edited",
	]);

	container.children[0] = replacement;
	expect(container.render(40), "replacing a public child must not reuse the old segment").toEqual([
		"replacement",
		"",
		"second",
		"",
		"edited",
	]);

	container.children.length = 1;
	expect(container.render(40), "removing public children must drop their rows").toEqual(["replacement"]);

	container.removeChild(replacement);
	container.children.push(replacement);
	replacement.setLines(["reinserted"]);
	expect(
		container.render(40),
		"a child reinserted through the public array remains conservatively polled after listener removal",
	).toEqual(["reinserted"]);
});

test("externally aliased child arrays conservatively detect out-of-band reorder", () => {
	const first = new MutableBlock(["first"]);
	const second = new MutableBlock(["second"]);
	const aliasedChildren = [first, second];
	const container = new TranscriptContainer();
	container.children = aliasedChildren;

	expect(container.render(40)).toEqual(["first", "", "second"]);
	aliasedChildren.reverse();
	expect(
		container.render(40),
		"an external array alias can mutate without Proxy traps and must disable stable-prefix reuse",
	).toEqual(["second", "", "first"]);
});

test("shared blocks keep each container subscribed independently", () => {
	const shared = new TrackedBlock(["shared"]);
	const left = new TranscriptContainer();
	const right = new TranscriptContainer();
	left.addChild(shared);
	right.addChild(shared);

	expect(left.render(40)).toEqual(["shared"]);
	expect(right.render(40)).toEqual(["shared"]);

	shared.setLines(["updated"]);
	expect(shared.notifications).toBe(1);
	expect(left.render(40)).toEqual(["updated"]);
	expect(right.render(40)).toEqual(["updated"]);

	right.removeChild(shared);
	shared.setLines(["left only"]);
	expect(shared.notifications, "removing a shared child from one container must not detach the other listener").toBe(
		2,
	);
	expect(left.render(40)).toEqual(["left only"]);
	expect(right.render(40)).toEqual([]);

	left.children.splice(0, 1);
	left.render(40);
	shared.setLines(["detached"]);
	expect(shared.notifications, "raw-array removal must detach the old parent listener").toBe(2);

	left.children.push(shared);
	left.render(40);
	shared.setLines(["reinserted"]);
	expect(shared.notifications, "reinserted public children must be re-subscribed or conservatively polled").toBe(3);
	expect(left.render(40)).toEqual(["reinserted"]);
});

test("replay invalidates a custom block without forcing unrelated history renders", () => {
	const replay = new ReplayTrackedBlock(["before"], ["after"]);
	const stable = new TrackedBlock(["stable"]);
	const container = new TranscriptContainer();
	container.addChild(replay);
	container.addChild(stable);

	const initial = container.render(40);
	container.setNativeScrollbackCommittedRows(initial.length);
	expect(container.render(40)).toEqual(initial);

	container.prepareNativeScrollbackReplay();
	expect(container.render(40), "custom replay output must invalidate the cached finalized prefix").toEqual([
		"after",
		"",
		"stable",
	]);
});

test("width epoch boundaries survive segment reuse and reject edited preceding history", () => {
	const first = new TrackedBlock(["first"]);
	const last = new WidthAwareTrackedBlock(["last"]);
	const container = new TranscriptContainer();
	container.addChild(first);
	container.addChild(last);

	const initial = container.render(40);
	const boundary = container.captureNativeScrollbackWidthEpoch();
	expect(boundary).toBeDefined();
	expect(container.resolveNativeScrollbackWidthEpoch(boundary)).toBe(initial.length);

	container.render(40);
	expect(
		container.resolveNativeScrollbackWidthEpoch(boundary),
		"an unchanged boundary remains valid after reusing segment records",
	).toBe(initial.length);

	first.setLines(["edited", "history"]);
	container.render(40);
	expect(
		container.resolveNativeScrollbackWidthEpoch(boundary),
		"editing finalized history invalidates a captured width boundary",
	).toBeUndefined();
});

test("resolvePreservedLiveToolCallIds preserves in-flight calls without a persisted result", () => {
	const live = makeLiveComponent();
	const livePendingTools = new Map([[CALL_ID, live as unknown as ToolExecutionHandle]]);
	const liveComponents: unknown[] = [live];
	const messages = [assistantMessageWithCall()];

	const preserved = resolvePreservedLiveToolCallIds({
		livePendingTools,
		liveComponents: liveComponents as any,
		messages,
	});

	expect(
		preserved.has(CALL_ID),
		"an executing call with no persisted result must be preserved so the replay does not duplicate it",
	).toBe(true);
	expect(livePendingTools.has(CALL_ID)).toBe(true);
	expect(liveComponents).toHaveLength(1);
});

test("resolvePreservedLiveToolCallIds drops live components the replay settles from a persisted result", () => {
	const live = makeLiveComponent();
	const livePendingTools = new Map([[CALL_ID, live as unknown as ToolExecutionHandle]]);
	const liveComponents: unknown[] = [live];
	const messages = [assistantMessageWithCall(), settledToolResultMessage()];

	const preserved = resolvePreservedLiveToolCallIds({
		livePendingTools,
		liveComponents: liveComponents as any,
		messages,
	});

	expect(preserved.has(CALL_ID), "a settled persisted result must be replayed, not preserved").toBe(false);
	expect(livePendingTools.has(CALL_ID)).toBe(false);
	expect(liveComponents, "the dropped live component must not be re-appended after the replay").toHaveLength(0);
});

test("replay skips preserved ids and creates components for unpreserved calls", () => {
	const chatContainer = new TranscriptContainer();
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const ctx = makeCtx(chatContainer, pendingTools);
	const helpers = new UiHelpers(ctx);
	const sessionContext: any = { messages: [assistantMessageWithCall()] };

	// Unpreserved: the replay creates a component and registers it as pending
	// (the replay swaps ctx.pendingTools to a staged map on success).
	helpers.renderSessionContext(sessionContext, {});
	expect(toolComponentsIn(chatContainer), "unpreserved in-flight call is rendered by the replay").toHaveLength(1);
	expect(ctx.pendingTools.get(CALL_ID)).toBeDefined();

	// Preserved: the replay must not create a second component for the call.
	const chatContainer2 = new TranscriptContainer();
	const pendingTools2 = new Map<string, ToolExecutionHandle>();
	const ctx2 = makeCtx(chatContainer2, pendingTools2);
	const helpers2 = new UiHelpers(ctx2);
	helpers2.renderSessionContext(sessionContext, { preservedLiveToolCallIds: new Set([CALL_ID]) });
	expect(
		toolComponentsIn(chatContainer2),
		"preserved in-flight call must not be re-created by the replay (the live component renders it)",
	).toHaveLength(0);
	expect(ctx2.pendingTools.get(CALL_ID), "preserved call must stay pending on the live component").toBeUndefined();
});

test("a tracked block reusing mutable rows updates the transcript instead of claiming a stale stable prefix", () => {
	const rows = ["before"];
	const block = new TrackedBlock(rows);
	const container = new TranscriptContainer();
	container.addChild(block);
	expect([...container.render(40)]).toEqual(["before"]);
	container.getRenderStablePrefixRows();
	rows[0] = "after";
	block.setLines(rows);
	expect([...container.render(40)]).toEqual(["after"]);
	expect(container.getRenderStablePrefixRows()).toBe(0);
});
