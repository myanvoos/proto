import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../src/config/settings";
import { ChatTranscriptBuilder } from "../../src/modes/components/chat-transcript-builder";
import { RETAINED_COMMITTED_BLOCKS, TranscriptContainer } from "../../src/modes/components/transcript-container";
import { initThemeSync } from "../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import { UiHelpers } from "../../src/modes/utils/ui-helpers";

await Settings.init();
initThemeSync();
const noop = () => {};
const ui = { requestRender: noop, requestComponentRender: noop } as unknown as TUI;
const builder = new ChatTranscriptBuilder({ ui, requestRender: noop });
function evictBuilderComponent(index: number): WeakRef<Component>[] {
	builder.append([
		{
			type: "message",
			id: String(index),
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "developer", content: `evicted expandable ${index}`, timestamp: 0 },
		},
	]);
	const components = [...builder.container.children];
	const refs = components.map(component => new WeakRef(component));
	for (const component of components) builder.container.disposeAndRemoveChild(component);
	return refs;
}
const builderRefs = Array.from({ length: 500 }, (_, index) => evictBuilderComponent(index)).flat();
builder.setExpanded(true);
const empty = new TranscriptContainer();
function clearRenderedComponent(): WeakRef<Component> {
	const component = { render: () => ["stale-cache-root"] };
	const ref = new WeakRef(component);
	empty.addChild(component);
	empty.renderViewport(80, 24, { tick: 1, now: 1 });
	empty.render(80);
	empty.clear();
	empty.renderViewport(80, 24, { tick: 1, now: 1 });
	empty.render(80);
	return ref;
}
const clearedRef = clearRenderedComponent();
const chatContainer = new TranscriptContainer();
const messages: AgentMessage[] = Array.from({ length: RETAINED_COMMITTED_BLOCKS + 100 }, (_, index) => ({
	role: "user",
	content: `user-${index}`,
	timestamp: index,
}));
const ctx = {
	ui,
	chatContainer,
	transcriptMessageComponents: new WeakMap<AgentMessage, WeakRef<Component>>(),
	viewSession: { sessionManager: { putBlobSync: noop } },
	toolOutputExpanded: false,
} as unknown as InteractiveModeContext;
const helper = new UiHelpers(ctx);
function populateChat(): WeakRef<Component>[] {
	for (const message of messages) helper.addMessageToChat(message);
	const refs = chatContainer.children.slice(0, 100).map(component => new WeakRef(component));
	const batch = chatContainer.peekFlushBatch(80)!;
	chatContainer.acknowledgeFinalizedBatch(batch.id);
	return refs;
}
const retiredRefs = populateChat();
// WeakRef keep-alive lasts until the current job ends; real event-loop turns are required for GC.
async function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}
async function survivors(refs: WeakRef<Component>[]): Promise<number> {
	let count = refs.length;
	for (let attempt = 0; attempt < 12; attempt++) {
		await nextTurn();
		Bun.gc(true);
		Bun.gc(true);
		await nextTurn();
		count = refs.filter(ref => ref.deref() !== undefined).length;
		if (count === 0) break;
	}
	return count;
}
const result = {
	evictedExpandables: await survivors(builderRefs),
	clearedComponent: await survivors([clearedRef]),
	retiredWhileMessagesRemain: await survivors(retiredRefs),
	retainedMessages: messages.length,
	retainedBlocks: chatContainer.children.length,
};
await Bun.write(Bun.stdout, JSON.stringify(result));
builder.dispose();
empty.dispose();
chatContainer.dispose();
