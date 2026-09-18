import * as fs from "node:fs";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { getStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { type Component, Editor, matchesKey, routeSgrMouseInput, ScrollView, type TUI } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRegistry, AgentStatus } from "../../registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import { replaceTabs, shortenPath, truncateToWidth } from "../../tools/render-utils";
import { decodeStreamedToolArgs, streamingStringKeysForTool } from "../controllers/tool-args-reveal";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { getEditorTheme, theme } from "../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { TRANSCRIPT_WINDOW_SOFT_BYTES, TRANSCRIPT_WINDOW_SOFT_MESSAGES } from "../utils/transcript-window";
import { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { DynamicBorder } from "./dynamic-border";
import { formatContextUsage } from "./status-line/context-thresholds";
import {
	readFileRangeSync,
	readTranscriptAfter,
	readTranscriptBefore,
	readTranscriptTail,
	type TranscriptFileWindow,
} from "./transcript-file-window";

interface AgentTranscriptViewerDeps {
	agentId: string;
	registry: AgentRegistry;

	observers?: SessionObserverRegistry;

	lifecycle?: () => AgentLifecycleManager;
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;

	isBuiltInTool?: (name: string) => boolean;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	expandKeys: KeyId[];

	fleetKeys: KeyId[];
	requestRender: () => void;

	onClose: () => void;

	onFleetClose: () => void;
}

const POLL_MS = 250;

const SENTINEL_BYTES = 4096;

function sanitizeViewerLine(text: string, maxWidth: number): string {
	const singleLine = replaceTabs(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/\/[^\s'")\]]+/g, p => shortenPath(p));
	return truncateToWidth(singleLine, Math.max(0, maxWidth));
}

interface LocalTranscriptSentinel {
	offset: number;
	bytes: Buffer;
}

interface TranscriptWindowGroup {
	start: number;
	startsBoundary: boolean;
	entries: FileEntry[];
	components: Component[];
}

interface LocalTranscriptState {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	windowStart: number;
	windowEnd: number;
	atTail: boolean;
	sentinels: LocalTranscriptSentinel[];
}

function sentinelOffsets(size: number): number[] {
	if (size <= 0) return [];
	const length = Math.min(SENTINEL_BYTES, size);
	return [...new Set([0, Math.max(0, Math.floor((size - length) / 2)), Math.max(0, size - length)])];
}

function sentinelsFromFile(file: string, size: number): LocalTranscriptSentinel[] {
	const length = Math.min(SENTINEL_BYTES, size);
	return sentinelOffsets(size).map(offset => ({ offset, bytes: readFileRangeSync(file, offset, length) }));
}

function statusBadge(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("success", "running");
		case "idle":
			return theme.fg("accent", "idle");
		case "parked":
			return theme.fg("muted", "parked");
		case "aborted":
			return theme.fg("error", "aborted");
	}
}

export class AgentTranscriptViewer implements Component {
	#builder: ChatTranscriptBuilder;
	#scrollView: ScrollView;
	#scrollContentLines: readonly string[] | undefined;
	#scrollContentRevision = -1;
	#emptyContentText: string | undefined;
	#emptyContentLines: readonly string[] = [];
	#followBottom = true;
	#scrollToTopOnNextContent = false;
	#editor: Editor | undefined;
	#notice: string | undefined;
	#expanded = false;

	#localState: LocalTranscriptState | undefined;
	#localUnavailable = "";

	#model: string | undefined;
	#windowGroups: TranscriptWindowGroup[] = [];
	#transientBuilder: ChatTranscriptBuilder | undefined;
	#awaitingTransientPersistence = false;
	#reconcileTimer: NodeJS.Timeout | undefined;
	#reconcileAttempts = 0;
	#liveSession: AgentSession | undefined;
	#unsubscribeSession: (() => void) | undefined;
	#unsubscribeRegistry: (() => void) | undefined;
	#pollTimer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(private readonly deps: AgentTranscriptViewerDeps) {
		this.#builder = new ChatTranscriptBuilder({
			ui: deps.ui,
			getTool: deps.getTool,
			isBuiltInTool: deps.isBuiltInTool,
			getMessageRenderer: deps.getMessageRenderer,
			hideThinkingBlock: deps.hideThinkingBlock,
			proseOnlyThinking: deps.proseOnlyThinking,
			requestRender: deps.requestRender,
		});
		this.#scrollView = new ScrollView([], {
			height: 10,
			scrollbar: "auto",
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		if (this.#sendable) {
			this.#editor = new Editor(getEditorTheme());
			this.#editor.setMaxHeight(4);
			this.#editor.onSubmit = text => this.#submit(text);
		}
		this.#refresh();
		this.#syncSessionSource();
		this.#unsubscribeRegistry = deps.registry.onChange(event => {
			if (event.ref.id === deps.agentId) this.#syncSessionSource();
		});
	}

	get #sendable(): boolean {
		const ref = this.deps.registry.get(this.deps.agentId);
		if (!ref || ref.kind === "advisor" || ref.status === "aborted") return false;
		return Boolean(this.deps.lifecycle);
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopPolling();
		this.#unsubscribeRegistry?.();
		this.#unsubscribeRegistry = undefined;
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		this.#liveSession = undefined;
		if (this.#reconcileTimer) clearTimeout(this.#reconcileTimer);
		this.#reconcileTimer = undefined;
		this.#clearTransient();
		this.#scrollView.setLines([]);
		this.#scrollContentLines = undefined;
		this.#scrollContentRevision = -1;
		this.#emptyContentText = undefined;
		this.#emptyContentLines = [];
		this.#scrollToTopOnNextContent = false;
		this.#localState = undefined;
		this.#localUnavailable = "";
		this.#windowGroups = [];
		this.#model = undefined;
		this.#notice = undefined;
		this.#builder.dispose();
	}

	#syncSessionSource(): void {
		const session = this.deps.registry.get(this.deps.agentId)?.session ?? undefined;
		if (session === this.#liveSession && (session !== undefined || this.#pollTimer !== undefined)) return;
		this.#unsubscribeSession?.();
		this.#unsubscribeSession = undefined;
		this.#liveSession = session;
		if (session) {
			this.#stopPolling();
			this.#unsubscribeSession = session.subscribe(event => this.#handleSessionEvent(event));
			this.#refresh();
			return;
		}
		this.#clearTransient();
		if (!this.#pollTimer && !this.#disposed) {
			this.#pollTimer = setInterval(() => this.#refresh(), POLL_MS);
			this.#pollTimer.unref?.();
		}
	}

	#handleSessionEvent(event: AgentSessionEvent): void {
		if (this.#disposed) return;
		if (event.type === "message_update" && event.message.role === "assistant") {
			this.#showTransient(event.message);
			return;
		}
		if (event.type !== "message_end") return;
		if (event.message.role === "assistant") this.#showTransient(event.message);
		if (event.message.role === "assistant") {
			this.#awaitingTransientPersistence = true;
			this.#reconcileAttempts = 0;
		}
		this.#schedulePersistenceReconcile();
	}

	#showTransient(message: Extract<AgentMessage, { role: "assistant" }>): void {
		if (this.#transientBuilder) this.#builder.container.removeChild(this.#transientBuilder.container);
		else {
			this.#transientBuilder = new ChatTranscriptBuilder({
				ui: this.deps.ui,
				getTool: this.deps.getTool,
				isBuiltInTool: this.deps.isBuiltInTool,
				getMessageRenderer: this.deps.getMessageRenderer,
				hideThinkingBlock: this.deps.hideThinkingBlock,
				proseOnlyThinking: this.deps.proseOnlyThinking,
				requestRender: this.deps.requestRender,
			});
		}
		const content = message.content.map(block => {
			if (block.type !== "toolCall") return block;
			const partialJson = getStreamingPartialJson(block);
			if (partialJson === undefined) return block;
			const rawInput = block.customWireName !== undefined;
			return {
				...block,
				arguments: decodeStreamedToolArgs(partialJson, {
					rawInput,
					fullArgs: block.arguments,
					streamingStringKeys: streamingStringKeysForTool(block.name, rawInput),
				}),
			};
		});
		this.#transientBuilder.rebuild([
			{
				type: "message",
				id: "viewer-live-message",
				parentId: null,
				timestamp: new Date(message.timestamp).toISOString(),
				message: { ...message, content },
			},
		]);
		this.#transientBuilder.setExpanded(this.#expanded);
		this.#builder.container.addChild(this.#transientBuilder.container);
		this.deps.requestRender();
	}

	#clearTransient(): void {
		const transient = this.#transientBuilder;
		if (!transient) return;
		this.#builder.container.removeChild(transient.container);
		transient.dispose();
		this.#transientBuilder = undefined;
		this.#awaitingTransientPersistence = false;
		this.#reconcileAttempts = 0;
	}

	#schedulePersistenceReconcile(): void {
		if (this.#reconcileTimer || this.#disposed) return;
		const delay = Math.min(250, 10 * 2 ** this.#reconcileAttempts);
		this.#reconcileTimer = setTimeout(() => {
			this.#reconcileTimer = undefined;
			this.#reconcileAttempts++;
			this.#refresh();
			if (this.#awaitingTransientPersistence && this.#reconcileAttempts < 8) {
				this.#schedulePersistenceReconcile();
			}
		}, delay);
		this.#reconcileTimer.unref?.();
	}

	#stopPolling(): void {
		if (!this.#pollTimer) return;
		clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	#refresh(): void {
		if (this.#disposed) return;
		const sessionFile = this.deps.registry.get(this.deps.agentId)?.sessionFile;
		if (!sessionFile) {
			this.#clearLocal("none");
			return;
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sessionFile);
		} catch {
			this.#clearLocal("missing");
			return;
		}
		const state = this.#localState;
		const wasFollowingTail = state === undefined || this.#followBottom;
		if (!state || !this.#sameFileContents(sessionFile, stat, state)) {
			this.#loadTail(sessionFile, stat, wasFollowingTail);
			return;
		}
		if (stat.size === state.size) {
			if (stat.mtimeMs !== state.mtimeMs || stat.ctimeMs !== state.ctimeMs) {
				this.#localState = { ...state, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
			}
			return;
		}
		if (!state.atTail) {
			this.#localState = {
				...state,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
				sentinels: sentinelsFromFile(sessionFile, stat.size),
			};
			this.deps.requestRender();
			return;
		}
		this.#appendFileGrowth(sessionFile, stat, state);
	}

	#clearLocal(reason: string): void {
		if (!this.#localState && this.#localUnavailable === reason) return;
		this.#localState = undefined;
		this.#localUnavailable = reason;
		this.#model = undefined;
		this.#windowGroups = [];
		this.#clearTransient();
		this.#rebuild([]);
	}

	#sameFileContents(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): boolean {
		if (state.path !== sessionFile || state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.size)
			return false;
		for (const sentinel of state.sentinels) {
			let current: Buffer;
			try {
				current = readFileRangeSync(sessionFile, sentinel.offset, sentinel.bytes.byteLength);
			} catch (err) {
				logger.debug("transcript viewer: sentinel read failed", { err: String(err) });
				return false;
			}
			if (!current.equals(sentinel.bytes)) return false;
		}
		return true;
	}

	#loadTail(sessionFile: string, stat: fs.Stats, followBottom = true): void {
		try {
			this.#loadWindow(
				sessionFile,
				stat,
				readTranscriptTail(sessionFile, stat.size, TRANSCRIPT_WINDOW_SOFT_BYTES, TRANSCRIPT_WINDOW_SOFT_MESSAGES),
				"bottom",
				true,
				followBottom,
			);
		} catch (err) {
			logger.debug("transcript viewer: tail window read failed", { err: String(err) });
		}
	}

	#loadWindow(
		sessionFile: string,
		stat: fs.Stats,
		window: TranscriptFileWindow,
		position: "top" | "bottom",
		atTail: boolean,
		followBottom = position === "bottom",
	): void {
		this.#localUnavailable = "";
		this.#localState = {
			path: sessionFile,
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
			windowStart: window.start,
			windowEnd: window.end,
			atTail,
			sentinels: sentinelsFromFile(sessionFile, stat.size),
		};
		this.#model = undefined;
		this.#followBottom = followBottom;
		this.#scrollToTopOnNextContent = position === "top";
		this.#clearTransient();
		this.#builder.rebuild([]);
		this.#windowGroups = [];
		this.#appendWindowGroups(this.#parseWindowGroups(window));
		this.deps.requestRender();
	}

	#parseWindowGroups(window: TranscriptFileWindow): TranscriptWindowGroup[] {
		const bytes = Buffer.from(window.text);
		const groups: TranscriptWindowGroup[] = [];
		let current: TranscriptWindowGroup | undefined;
		let prelude: FileEntry[] = [];
		let lineStart = 0;
		while (lineStart < bytes.byteLength) {
			const newline = bytes.indexOf(0x0a, lineStart);
			if (newline < 0) break;
			const entries = parseSessionEntries(bytes.subarray(lineStart, newline + 1).toString("utf-8"));
			for (const entry of entries) {
				const boundary =
					entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
				if (boundary) {
					if (current) groups.push(current);
					current = {
						start: prelude.length > 0 ? window.start : window.start + lineStart,
						startsBoundary: true,
						entries: [...prelude, entry],
						components: [],
					};
					prelude = [];
				} else if (current) current.entries.push(entry);
				else prelude.push(entry);
			}
			lineStart = newline + 1;
		}
		if (current) groups.push(current);
		else if (prelude.length > 0) {
			groups.push({ start: window.start, startsBoundary: false, entries: prelude, components: [] });
		}
		return groups;
	}

	#appendWindowGroups(groups: TranscriptWindowGroup[]): void {
		for (const group of groups) {
			let target = group;
			if (!group.startsBoundary && this.#windowGroups.length > 0) target = this.#windowGroups.at(-1)!;
			else this.#windowGroups.push(group);
			const before = new Set(this.#builder.container.children);
			this.#append(this.#extractMessages(group.entries));
			for (const component of this.#builder.container.children) {
				if (!before.has(component)) target.components.push(component);
			}
		}
	}

	#appendFileGrowth(sessionFile: string, stat: fs.Stats, state: LocalTranscriptState): void {
		let cursor = state.windowEnd;
		try {
			for (;;) {
				const window = readTranscriptAfter(
					sessionFile,
					cursor,
					stat.size,
					TRANSCRIPT_WINDOW_SOFT_BYTES,
					TRANSCRIPT_WINDOW_SOFT_MESSAGES,
				);
				if (window.end <= cursor) break;
				if (this.#awaitingTransientPersistence) this.#clearTransient();
				this.#appendWindowGroups(this.#parseWindowGroups(window));
				cursor = window.end;
			}
			this.#evictOldGroups(cursor);
			this.#localState = {
				...state,
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				ctimeMs: stat.ctimeMs,
				windowStart: this.#windowGroups[0]?.start ?? cursor,
				windowEnd: cursor,
				atTail: true,
				sentinels: sentinelsFromFile(sessionFile, stat.size),
			};
			this.deps.requestRender();
		} catch (err) {
			logger.debug("transcript viewer: incremental tail read failed", { err: String(err) });
		}
	}

	#evictOldGroups(end: number): void {
		while (
			this.#windowGroups.length > 1 &&
			(this.#windowGroups.length > TRANSCRIPT_WINDOW_SOFT_MESSAGES ||
				end - this.#windowGroups[0]!.start > TRANSCRIPT_WINDOW_SOFT_BYTES)
		) {
			const evicted = this.#windowGroups.shift()!;
			for (const component of evicted.components) {
				if (this.#builder.container.children.includes(component)) {
					this.#builder.container.disposeAndRemoveChild(component);
				}
			}
		}
	}

	#pageOlder(): boolean {
		const state = this.#localState;
		if (!state || state.windowStart === 0) return false;
		try {
			const window = readTranscriptBefore(
				state.path,
				state.windowStart,
				TRANSCRIPT_WINDOW_SOFT_BYTES,
				TRANSCRIPT_WINDOW_SOFT_MESSAGES,
			);
			this.#loadWindow(state.path, fs.statSync(state.path), window, "bottom", false);
			return true;
		} catch (err) {
			logger.debug("transcript viewer: older window read failed", { err: String(err) });
			return false;
		}
	}

	#pageNewer(): boolean {
		const state = this.#localState;
		if (!state || state.atTail) return false;
		try {
			const window = readTranscriptAfter(
				state.path,
				state.windowEnd,
				state.size,
				TRANSCRIPT_WINDOW_SOFT_BYTES,
				TRANSCRIPT_WINDOW_SOFT_MESSAGES,
			);
			if (window.end <= state.windowEnd) return false;
			this.#loadWindow(state.path, fs.statSync(state.path), window, "top", window.end >= state.size);
			return true;
		} catch (err) {
			logger.debug("transcript viewer: newer window read failed", { err: String(err) });
			return false;
		}
	}

	#jumpOldest(): void {
		const state = this.#localState;
		if (!state) return;
		try {
			const window = readTranscriptAfter(
				state.path,
				0,
				state.size,
				TRANSCRIPT_WINDOW_SOFT_BYTES,
				TRANSCRIPT_WINDOW_SOFT_MESSAGES,
			);
			this.#loadWindow(state.path, fs.statSync(state.path), window, "top", false);
		} catch (err) {
			logger.debug("transcript viewer: oldest window read failed", { err: String(err) });
		}
	}

	#jumpNewest(): void {
		const state = this.#localState;
		if (!state) return;
		try {
			this.#loadTail(state.path, fs.statSync(state.path));
		} catch (err) {
			logger.debug("transcript viewer: newest window read failed", { err: String(err) });
		}
	}

	#extractMessages(entries: FileEntry[]): SessionMessageEntry[] {
		const messages: SessionMessageEntry[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				messages.push(entry);
				if (!this.#model && entry.message.role === "assistant") this.#model = entry.message.model;
			} else if (entry.type === "model_change") {
				this.#model = entry.model;
			}
		}
		return messages;
	}

	#rebuild(entries: SessionMessageEntry[]): void {
		this.#builder.rebuild(entries);
		this.deps.requestRender();
	}

	#append(entries: SessionMessageEntry[]): void {
		this.#builder.append(entries);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollView.scroll(event.wheel * 3);
					this.#syncFollow();
					this.deps.requestRender();
				}
				return true;
			});
			return;
		}

		for (const key of this.deps.fleetKeys) {
			if (matchesKey(data, key)) {
				this.deps.onFleetClose();
				return;
			}
		}

		if (matchesKey(data, "escape")) {
			if (this.#editor && this.#editor.getText().trim() !== "") {
				this.#editor.setText("");
				this.deps.requestRender();
				return;
			}
			this.deps.onClose();
			return;
		}

		for (const key of this.deps.expandKeys) {
			if (matchesKey(data, key)) {
				this.#expanded = !this.#expanded;
				this.#builder.setExpanded(this.#expanded);
				this.deps.requestRender();
				return;
			}
		}

		const editorEmpty = !this.#editor || this.#editor.getText().trim() === "";
		if (editorEmpty && this.#handleScroll(data)) return;

		if (this.#editor) {
			this.#editor.handleInput(data);
			this.deps.requestRender();
		}
	}

	#handleScroll(data: string): boolean {
		if (matchesKey(data, "pageUp") && this.#scrollView.getScrollOffset() === 0 && this.#pageOlder()) {
			this.deps.requestRender();
			return true;
		}
		if (
			matchesKey(data, "pageDown") &&
			this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset() &&
			this.#pageNewer()
		) {
			this.deps.requestRender();
			return true;
		}
		if (this.#scrollView.handleScrollKey(data)) {
			this.#syncFollow();
			this.deps.requestRender();
			return true;
		}
		if (matchesKey(data, "j") || matchesSelectDown(data)) {
			this.#scrollView.scroll(1);
		} else if (matchesKey(data, "k") || matchesSelectUp(data)) {
			this.#scrollView.scroll(-1);
		} else if (data === "g") {
			this.#jumpOldest();
			this.deps.requestRender();
			return true;
		} else if (data === "G") {
			this.#jumpNewest();
			this.deps.requestRender();
			return true;
		} else {
			return false;
		}
		this.#syncFollow();
		this.deps.requestRender();
		return true;
	}

	#syncFollow(): void {
		this.#followBottom = this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset();
	}

	#submit(text: string): void {
		const trimmed = text.trim();
		this.#editor?.setText("");
		if (!trimmed) return;
		this.#notice = undefined;
		const id = this.deps.agentId;
		const lifecycle = this.deps.lifecycle;
		if (!lifecycle) return;
		void (async () => {
			try {
				const session = await lifecycle().ensureLive(id);

				await session.prompt(trimmed, { streamingBehavior: "steer" });
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.deps.requestRender();
		})();
		this.deps.requestRender();
	}

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;

		const innerWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(1, width - 1);
		const ref = this.deps.registry.get(this.deps.agentId);

		const headerLines = this.#headerLines(ref?.status, ref?.kind, ref?.parentId);
		const footerLines = this.#footerLines();
		const noticeLine = this.#notice
			? ` ${theme.fg("error", sanitizeViewerLine(this.#notice, innerWidth))}`
			: undefined;
		const editorLines = this.#editor ? this.#editor.render(innerWidth) : [];

		const chrome = headerLines.length + 2 + editorLines.length + footerLines.length + (noticeLine ? 1 : 0) + 1;
		const viewportHeight = Math.max(3, termHeight - chrome);

		let contentLines: readonly string[];
		let contentRevision: number;
		if (this.#builder.isEmpty) {
			const placeholder = this.#placeholder();
			if (this.#emptyContentText !== placeholder) {
				this.#emptyContentText = placeholder;
				this.#emptyContentLines = [` ${theme.fg("dim", placeholder)}`];
			}
			contentLines = this.#emptyContentLines;
			contentRevision = -1;
		} else {
			contentLines = this.#builder.container.render(contentWidth);
			contentRevision = this.#builder.container.getRenderRevision();
		}
		if (contentLines !== this.#scrollContentLines || contentRevision !== this.#scrollContentRevision) {
			this.#scrollView.setLines(contentLines, {
				preserveAnchor: !this.#followBottom && !this.#scrollToTopOnNextContent,
			});
			this.#scrollContentLines = contentLines;
			this.#scrollContentRevision = contentRevision;
		}
		if (this.#scrollToTopOnNextContent) {
			this.#scrollView.scrollToTop();
			this.#scrollToTopOnNextContent = false;
		}
		this.#scrollView.setHeight(viewportHeight);
		if (this.#followBottom) this.#scrollView.scrollToBottom();

		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		for (const headerLine of headerLines) lines.push(sanitizeViewerLine(` ${headerLine}`, width));
		lines.push(...new DynamicBorder().render(width));
		for (const row of this.#scrollView.render(width)) lines.push(row);
		if (noticeLine) lines.push(sanitizeViewerLine(noticeLine, width));
		for (const editorLine of editorLines) lines.push(sanitizeViewerLine(` ${editorLine}`, width));
		for (const footerLine of footerLines) lines.push(sanitizeViewerLine(footerLine, width));
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#headerLines(status: AgentStatus | undefined, kind: string | undefined, parentId: string | undefined): string[] {
		const lines = [theme.fg("accent", `Agent Fleet ${theme.sep.dot} ${this.deps.agentId}`)];
		if (status && kind) {
			const kindTag = theme.fg("dim", ` ${parentId ? `${kind} ${theme.sep.dot} of ${parentId}` : kind}`);
			const modelLabel = this.#model ? theme.fg("muted", `${theme.sep.dot}${this.#model}`) : "";
			lines.push(`${theme.bold(this.deps.agentId)} ${statusBadge(status)}${kindTag}${modelLabel}`);
		}
		return lines;
	}

	#footerLines(): string[] {
		const lines: string[] = [];
		const statsLine = this.#statsLine();
		if (statsLine) lines.push(` ${statsLine}`);
		const paging = this.#pagingStatus();
		if (paging) lines.push(` ${theme.fg("dim", paging)}`);
		const hint = this.#editor
			? `Enter:send  Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  empty input → PgUp/PgDn:page  g/G:first/latest`
			: `Esc:close  ${this.deps.expandKeys[0] ?? "ctrl+o"}:expand  PgUp/PgDn:page  g/G:first/latest`;
		lines.push(` ${theme.fg("dim", hint)}`);
		return lines;
	}

	#pagingStatus(): string {
		const state = this.#localState;
		if (!state) return "";
		const older = state.windowStart > 0 ? "← older" : "start";
		const newer = state.atTail ? "latest" : "newer →";
		return `${older}  ${newer}`;
	}

	#statsLine(): string {
		const observed: ObservableSession | undefined = this.deps.observers?.getSession(this.deps.agentId);
		const progress = observed?.progress;
		if (!progress) return "";
		const stats: string[] = [];
		if (progress.contextTokens && progress.contextTokens > 0) {
			stats.push(
				progress.contextWindow && progress.contextWindow > 0
					? formatContextUsage(progress.contextTokens, progress.contextWindow)
					: formatNumber(progress.contextTokens),
			);
		}
		if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
		const parts: string[] = [];
		if (stats.length > 0 || progress.toolCount > 0) {
			const toolStat =
				progress.toolCount > 0 ? `${formatNumber(progress.toolCount)} ${theme.icon.extensionTool}` : "";
			parts.push(theme.fg("dim", [toolStat, ...stats].filter(Boolean).join(theme.sep.dot)));
		}
		if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		return parts.join(theme.sep.dot);
	}

	#placeholder(): string {
		if (!this.deps.registry.get(this.deps.agentId)?.sessionFile) return "No session file available yet.";
		return "No messages yet.";
	}
}
