import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type AutocompleteProvider, matchesKey, type SlashCommand } from "@oh-my-pi/pi-tui";
import { isEnoent, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../../config/settings";
import { resolveLocalRoot } from "../../internal-urls";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { extractImagePathFromText } from "../../modes/components/custom-editor";
import { ReadToolGroupComponent } from "../../modes/components/read-tool-group";
import { renderSegmentTrack } from "../../modes/components/segment-track";
import { TinyTitleDownloadProgressComponent } from "../../modes/components/tiny-title-download-progress";
import { ToolExecutionComponent } from "../../modes/components/tool-execution";
import { TreeSelectorComponent } from "../../modes/components/tree-selector";
import { chipLabel, compactImageMarkers, shiftImageMarkers } from "../../modes/composer-attachments";
import { expandEmoticons } from "../../modes/emoji-autocomplete";
import { materializeImageReferenceLinks, setCachedImageDimensions } from "../../modes/image-references";
import { createPromptActionAutocompleteProvider } from "../../modes/prompt-action-autocomplete";
import { parseQueueShorthand, splitQueuedMessages } from "../../modes/queue-input";
import { buildSkillCommandPrompt, isKnownSkillCommand } from "../../modes/skill-command";
import type { InteractiveModeContext } from "../../modes/types";
import manualContinuePrompt from "../../prompts/system/manual-continue.md" with { type: "text" };
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeBuiltinSlashCommand, lookupBuiltinSlashCommand } from "../../slash-commands/builtin-registry";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { isTinyTitleLocalModelKey } from "../../tiny/models";
import { tinyTitleClient } from "../../tiny/title-client";
import type { TinyTitleProgressEvent } from "../../tiny/title-protocol";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import {
	copyToClipboard,
	readImageFromClipboard,
	readMacFileUrlsFromClipboard,
	readTextFromClipboard,
} from "../../utils/clipboard";
import { getSlashCommandUsage, loadSlashCommandUsage, recordSlashCommandUsage } from "../../utils/command-usage";
import { EnhancedPasteController } from "../../utils/enhanced-paste";
import { getEditorCommand, openInEditor } from "../../utils/external-editor";
import { ensureSupportedImageInput, ImageInputTooLargeError, loadImageInput } from "../../utils/image-loading";
import { resizeImage } from "../../utils/image-resize";

export function shouldSkipHistory(slashText: string): boolean {
	if (!slashText.startsWith("/")) return false;
	const body = slashText.slice(1);

	const firstWs = body.search(/\s/);
	const firstColon = body.indexOf(":");
	const sep = firstWs === -1 ? firstColon : firstColon === -1 ? firstWs : Math.min(firstWs, firstColon);
	const name = sep === -1 ? body : body.slice(0, sep);
	const hasArgs = sep !== -1;

	if (name === "login" && hasArgs) return true;
	if (name === "mcp") {
		const args = body.slice(sep + 1).trim();
		return args.startsWith("add") && /--token\s/.test(args);
	}
	return false;
}

interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

interface PasteTarget {
	pasteText(text: string): void;
}

function hasPasteText(value: unknown): value is PasteTarget {
	return typeof value === "object" && value !== null && typeof (value as PasteTarget).pasteText === "function";
}

const SHELL_PROMPT_COMMAND_RE =
	/^(?:\.{0,2}\/|~\/|cd(?:\s|$)|sudo(?:\s|$)|git(?:\s|$)|bun(?:\s|$)|npm(?:\s|$)|pnpm(?:\s|$)|yarn(?:\s|$)|node(?:\s|$)|python\d*(?:\s|$)|cargo(?:\s|$)|go(?:\s|$)|make(?:\s|$)|docker(?:\s|$)|kubectl(?:\s|$))/;
const SHELL_PROMPT_OPERATOR_RE = /(?:^|\s)(?:&&|\|\||\||2>&1|[<>]{1,2})(?:\s|$)/;
const PROTO_STATUS_LINE_RE = /^\s*in:\s+\d+\s+out:\s+\d+(?:\s+cache\s+\S+)?\s+t:\s+\S+\s+tok\/s:\s+\S+/m;

function looksLikePastedShellPrompt(code: string): boolean {
	const firstLine = code.split("\n", 1)[0]?.trimStart() ?? "";
	return (
		SHELL_PROMPT_COMMAND_RE.test(firstLine) ||
		SHELL_PROMPT_OPERATOR_RE.test(firstLine) ||
		PROTO_STATUS_LINE_RE.test(code)
	);
}

function pythonCommandPrefixLength(trimmedText: string): 0 | 1 | 2 {
	if (trimmedText.charCodeAt(0) !== 36) return 0;
	if (trimmedText.charCodeAt(1) === 123) return 0;

	const prefixLength = trimmedText.charCodeAt(1) === 36 ? 2 : 1;
	const next = trimmedText.charCodeAt(prefixLength);
	if (Number.isNaN(next)) return prefixLength;
	return next === 32 || next === 9 || next === 10 || next === 13 ? prefixLength : 0;
}

function parsePythonCommandInput(text: string): { code: string; isExcluded: boolean } | undefined {
	const trimmed = text.trimStart();
	const prefixLength = pythonCommandPrefixLength(trimmed);
	if (prefixLength === 0) return undefined;
	const code = trimmed.slice(prefixLength).trim();
	if (prefixLength === 1 && looksLikePastedShellPrompt(code)) return undefined;
	return {
		code,
		isExcluded: prefixLength === 2,
	};
}

function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

function safeAbort(label: string, fn: () => void): void {
	try {
		fn();
	} catch (err) {
		logger.debug(`Failed to abort ${label}`, { error: err instanceof Error ? err.message : String(err) });
	}
}

const TINY_TITLE_PROGRESS_DONE_TTL_MS = 3_000;

const TINY_TITLE_PROGRESS_REVEAL_DELAY_MS = 1_000;

const LEFT_DOUBLE_TAP_MIN_GAP_MS = 40;
const LEFT_DOUBLE_TAP_MAX_GAP_MS = 500;

export class InputController {
	constructor(
		private ctx: InteractiveModeContext,

		private clipboard: {
			readImage: typeof readImageFromClipboard;
			readText: typeof readTextFromClipboard;
			readMacFileUrls?: typeof readMacFileUrlsFromClipboard;
		} = {
			readImage: readImageFromClipboard,
			readText: readTextFromClipboard,
			readMacFileUrls: readMacFileUrlsFromClipboard,
		},
	) {}

	notifyTitleGenerationStart(): void {
		this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
	}

	#enhancedPaste?: EnhancedPasteController;
	#draftText: string | undefined;
	#focusedLeftTapListenerInstalled = false;
	#rightTapListenerInstalled = false;
	#focusedPasteListenerInstalled = false;
	#sideQuestionBranchListenerInstalled = false;
	#sideQuestionCopyListenerInstalled = false;
	#expandToolsListenerInstalled = false;

	getDraftText(): string {
		return this.#draftText ?? this.ctx.editor.getText();
	}

	#tapCounts: Record<"left" | "right", number> = { left: 0, right: 0 };

	#pasteCounter = 0;

	#lastChipsSignature = "";

	#showTinyTitleDownloadProgress(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey)) return;
		const component = new TinyTitleDownloadProgressComponent(modelKey);
		let added = false;
		let disposed = false;
		let removeTimer: NodeJS.Timeout | undefined;
		const remove = (): void => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			if (removeTimer) {
				clearTimeout(removeTimer);
				removeTimer = undefined;
			}
			if (added) {
				this.ctx.chatContainer.removeChild(component);
				this.ctx.ui.requestRender();
			}
		};
		const scheduleRemove = (): void => {
			if (removeTimer) clearTimeout(removeTimer);
			removeTimer = setTimeout(remove, TINY_TITLE_PROGRESS_DONE_TTL_MS);
			removeTimer.unref?.();
		};
		let revealAt = 0;
		const update = (event: TinyTitleProgressEvent): void => {
			if (disposed || event.modelKey !== modelKey) return;
			component.update(event);
			if (revealAt === 0) revealAt = performance.now() + TINY_TITLE_PROGRESS_REVEAL_DELAY_MS;
			const complete = component.isComplete();

			if (!added && !complete && performance.now() >= revealAt) {
				this.ctx.chatContainer.addChild(component);
				added = true;
			}
			if (added) this.ctx.ui.requestRender();
			if (complete) {
				if (added) scheduleRemove();
				else remove();
			}
		};
		const unsubscribe = tinyTitleClient.onProgress(update);
	}

	#abortStreamingTurn(): void {
		void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
	}

	setupKeyHandlers(): void {
		this.#draftText ??= this.ctx.editor.getText();
		this.ctx.editor.setActionKeys("app.interrupt", this.ctx.keybindings.getKeys("app.interrupt"));
		if (!this.#focusedLeftTapListenerInstalled) {
			this.#focusedLeftTapListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!this.ctx.focusedAgentId) return undefined;

				if (this.ctx.ui.hasOverlay()) return undefined;
				if (!matchesKey(data, "left")) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				this.#handleFocusedLeftTap();
				return { consume: true };
			});
		}
		if (!this.#rightTapListenerInstalled) {
			this.#rightTapListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (this.ctx.focusedAgentId) return undefined;

				if (this.ctx.ui.hasOverlay()) return undefined;
				if (!matchesKey(data, "right")) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				if (this.#detectDoubleTap("right")) {
					void this.ctx.showAgentsView("current");
					return { consume: true };
				}
				return undefined;
			});
		}
		if (!this.#sideQuestionBranchListenerInstalled) {
			this.#sideQuestionBranchListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "b")) return undefined;
				if (!this.ctx.handlesSideQuestionBranchKey()) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.handleSideQuestionBranchKey();
				return { consume: true };
			});
		}
		if (!this.#sideQuestionCopyListenerInstalled) {
			this.#sideQuestionCopyListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				if (!matchesKey(data, "c")) return undefined;
				if (!this.ctx.canCopySideQuestion()) return undefined;
				if (this.ctx.ui.getFocused() !== this.ctx.editor) return undefined;
				if (this.ctx.editor.getText().trim()) return undefined;
				void this.ctx.handleSideQuestionCopyKey();
				return { consume: true };
			});
		}
		if (!this.#focusedPasteListenerInstalled) {
			this.#focusedPasteListenerInstalled = true;
			this.ctx.ui.addInputListener(data => {
				const focused = this.ctx.ui.getFocused();
				if (!focused || focused === this.ctx.editor || !hasPasteText(focused)) return undefined;
				if (!this.ctx.keybindings.matches(data, "app.clipboard.pasteImage")) return undefined;
				void this.handleImagePaste();
				return { consume: true };
			});
		}
		if (!this.#expandToolsListenerInstalled) {
			this.#expandToolsListenerInstalled = true;

			this.ctx.ui.addInputListener(data => {
				if (!this.ctx.keybindings.matches(data, "app.tools.expand")) return undefined;
				if (this.ctx.ui.hasOverlay()) return undefined;
				if (this.ctx.ui.getFocused() instanceof TreeSelectorComponent && matchesKey(data, "ctrl+o"))
					return undefined;
				this.toggleToolOutputExpansion();
				return { consume: true };
			});
		}
		this.ctx.editor.onEscape = () => {
			if (this.ctx.mcpTestEscapeHandlers.size > 0) {
				const handlers = [...this.ctx.mcpTestEscapeHandlers];
				this.ctx.mcpTestEscapeHandlers.clear();
				for (const handler of handlers) handler();
				return;
			}

			if (this.ctx.hasActiveSideQuestion() && this.ctx.handleSideQuestionEscape()) {
				return;
			}

			if (!this.ctx.focusedAgentId) {
				const viewSession = this.ctx.viewSession;
				let aborted = false;
				if (viewSession.isCompacting) {
					safeAbort("compaction", () => viewSession.abortCompaction());
					aborted = true;
				}
				if (viewSession.isRetrying) {
					safeAbort("retry", () => viewSession.abortRetry());
					aborted = true;
				}
				if (aborted) return;
			}

			if (this.ctx.loopModeEnabled) {
				if (this.ctx.session.isStreaming) {
					this.#abortStreamingTurn();
				} else {
					this.ctx.pauseLoop();
					this.ctx.cancelPendingSubmission();
				}
				return;
			}
			if (this.ctx.focusedAgentId) {
				if (this.ctx.editor.getText().trim()) {
					this.ctx.editor.setText("");
					this.ctx.ui.requestRender();
				} else {
					this.#returnFocusedToAgentBrowser();
				}
				return;
			}
			if (this.ctx.loadingAnimation) {
				if (this.ctx.cancelPendingSubmission()) {
					return;
				}
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.ctx.session.isBashRunning) {
				this.ctx.session.abortBash();
			} else if (this.ctx.isBashMode) {
				this.ctx.editor.setText("");
				this.ctx.isBashMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isEvalRunning) {
				this.ctx.session.abortEval();
			} else if (this.ctx.isPythonMode) {
				this.ctx.editor.setText("");
				this.ctx.isPythonMode = false;
				this.ctx.updateEditorBorderColor();
			} else if (this.ctx.session.isStreaming) {
				this.#abortStreamingTurn();
			} else if (this.ctx.editor.getText().trim()) {
				this.ctx.lastEscapeTime = 0;
			} else {
				const action = settings.get("doubleEscapeAction");
				if (action !== "none") {
					const now = Date.now();
					if (now - this.ctx.lastEscapeTime < 500) {
						if (action === "tree") {
							this.ctx.showTreeSelector();
						} else {
							this.ctx.showUserMessageSelector();
						}

						this.ctx.ui.requestRender(true);
						this.ctx.lastEscapeTime = 0;
					} else {
						this.ctx.lastEscapeTime = now;
					}
				}
			}
		};

		this.ctx.editor.setActionKeys("app.clear", this.ctx.keybindings.getKeys("app.clear"));
		this.ctx.editor.onClear = () => this.handleCtrlC();
		this.ctx.editor.setActionKeys("app.exit", this.ctx.keybindings.getKeys("app.exit"));
		this.ctx.editor.setActionKeys("app.display.reset", this.ctx.keybindings.getKeys("app.display.reset"));
		this.ctx.editor.onDisplayReset = () => {
			this.ctx.resetDisplayAfterAppearanceRefresh();
		};
		this.ctx.editor.onExit = () => this.handleCtrlD();
		this.ctx.editor.setActionKeys("app.suspend", this.ctx.keybindings.getKeys("app.suspend"));
		this.ctx.editor.onSuspend = () => this.handleCtrlZ();
		this.ctx.editor.setActionKeys("app.thinking.cycle", this.ctx.keybindings.getKeys("app.thinking.cycle"));
		this.ctx.editor.onCycleThinkingLevel = () => this.cycleThinkingLevel();
		this.ctx.editor.setActionKeys("app.model.cycleForward", this.ctx.keybindings.getKeys("app.model.cycleForward"));
		this.ctx.editor.onCycleModelForward = () => this.cycleRoleModel("forward");
		this.ctx.editor.setActionKeys("app.model.cycleBackward", this.ctx.keybindings.getKeys("app.model.cycleBackward"));
		this.ctx.editor.onCycleModelBackward = () => this.cycleRoleModel("backward");
		this.ctx.editor.setActionKeys(
			"app.model.selectTemporary",
			this.ctx.keybindings.getKeys("app.model.selectTemporary"),
		);
		this.ctx.editor.onSelectModelTemporary = () => this.ctx.showModelSelector({ temporaryOnly: true });

		this.ctx.editor.setActionKeys("app.model.select", this.ctx.keybindings.getKeys("app.model.select"));
		this.ctx.editor.onSelectModel = () => this.ctx.showModelSelector();
		this.ctx.editor.setActionKeys("app.history.search", this.ctx.keybindings.getKeys("app.history.search"));
		this.ctx.editor.onHistorySearch = () => this.ctx.showHistorySearch();
		this.ctx.editor.setActionKeys("app.thinking.toggle", this.ctx.keybindings.getKeys("app.thinking.toggle"));
		this.ctx.editor.onToggleThinking = () => this.ctx.toggleThinkingBlockVisibility();
		this.ctx.editor.setActionKeys("app.editor.external", this.ctx.keybindings.getKeys("app.editor.external"));
		this.ctx.editor.onExternalEditor = () => void this.openExternalEditor();
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteImage",
			this.ctx.keybindings.getKeys("app.clipboard.pasteImage"),
		);
		this.ctx.editor.onPasteImage = () => this.handleImagePaste();
		this.ctx.editor.onPasteImagePath = path => this.handleImagePathPaste(path);
		this.ctx.editor.setActionKeys(
			"app.clipboard.pasteTextRaw",
			this.ctx.keybindings.getKeys("app.clipboard.pasteTextRaw"),
		);
		this.ctx.editor.onPasteTextRaw = () => void this.handleClipboardTextRawPaste();
		this.ctx.editor.onLargePaste = (text, lineCount) => this.handleLargePaste(text, lineCount);
		this.ctx.editor.setActionKeys(
			"app.clipboard.copyPrompt",
			this.ctx.keybindings.getKeys("app.clipboard.copyPrompt"),
		);
		this.ctx.editor.onCopyPrompt = () => this.handleCopyPrompt();
		this.ctx.editor.setActionKeys(
			"app.tools.toggleVisibility",
			this.ctx.keybindings.getKeys("app.tools.toggleVisibility"),
		);
		this.ctx.editor.onToggleToolActivity = () => this.toggleToolActivityVisibility();
		this.ctx.editor.setActionKeys("app.message.dequeue", this.ctx.keybindings.getKeys("app.message.dequeue"));
		this.ctx.editor.onDequeue = () => this.handleDequeue();
		this.ctx.editor.clearCustomKeyHandlers();

		this.registerExtensionShortcuts();
		for (const key of this.ctx.keybindings.getKeys("app.session.new")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.handleClearCommand());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.tree")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showTreeSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.fork")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showUserMessageSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.session.resume")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showSessionSelector());
		}
		for (const key of this.ctx.keybindings.getKeys("app.history.older")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.navigateTranscriptHistory("older"));
		}
		for (const key of this.ctx.keybindings.getKeys("app.history.newer")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.navigateTranscriptHistory("newer"));
		}
		for (const key of this.ctx.keybindings.getKeys("app.history.latest")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.ctx.navigateTranscriptHistory("latest"));
		}
		for (const key of this.ctx.keybindings.getKeys("app.message.followUp")) {
			this.ctx.editor.setCustomKeyHandler(key, () => void this.handleFollowUp());
		}
		for (const key of this.ctx.keybindings.getKeys("app.clipboard.copyLine")) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.handleCopyCurrentLine());
		}
		const hubKeys = new Set([
			...this.ctx.keybindings.getKeys("app.agents.fleet"),
			...this.ctx.keybindings.getKeys("app.session.observe"),
		]);
		for (const key of hubKeys) {
			this.ctx.editor.setCustomKeyHandler(key, () => this.ctx.showAgentFleet());
		}

		this.ctx.editor.onLeftAtStart = () => {
			if (this.ctx.focusedAgentId) {
				this.#handleFocusedLeftTap();
				return;
			}
			if (this.#detectDoubleTap("left")) {
				this.ctx.showAgentsView("global");
			}
		};

		this.#setupEnhancedPaste();

		this.ctx.editor.onChange = (text: string) => {
			this.#draftText = text;
			const wasBashMode = this.ctx.isBashMode;
			const wasPythonMode = this.ctx.isPythonMode;
			const trimmed = text.trimStart();
			this.ctx.isBashMode = trimmed.startsWith("!");
			this.ctx.isPythonMode = parsePythonCommandInput(trimmed) !== undefined;
			if (wasBashMode !== this.ctx.isBashMode || wasPythonMode !== this.ctx.isPythonMode) {
				this.ctx.updateEditorBorderColor();
			}

			const chipsSignature = this.ctx.editor
				.composerChips()
				.map(chip => `${chip.kind}${chip.n}`)
				.join(",");
			if (chipsSignature !== this.#lastChipsSignature) {
				this.#lastChipsSignature = chipsSignature;
				this.ctx.ui.requestRender();
			}
		};
	}

	#handleFocusedLeftTap(): void {
		if (this.#detectDoubleTap("left")) {
			this.#returnFocusedToAgentBrowser();
		}
	}

	#returnFocusedToAgentBrowser(): void {
		void this.ctx.showAgentsView("current").then(() => this.ctx.unfocusSession());
	}

	#detectDoubleTap(direction: "left" | "right"): boolean {
		const now = Date.now();
		const lastTimeField = direction === "left" ? "lastLeftTapTime" : "lastRightTapTime";
		const sinceLast = now - this.ctx[lastTimeField];
		this.ctx[lastTimeField] = now;
		if (sinceLast >= LEFT_DOUBLE_TAP_MAX_GAP_MS) {
			this.#tapCounts[direction] = 1;
			return false;
		}
		this.#tapCounts[direction] += 1;
		if (this.#tapCounts[direction] === 2 && sinceLast >= LEFT_DOUBLE_TAP_MIN_GAP_MS) {
			this.#tapCounts[direction] = 0;
			this.ctx[lastTimeField] = 0;
			return true;
		}
		return false;
	}

	#setupEnhancedPaste(): void {
		if (this.#enhancedPaste) return;

		this.#enhancedPaste = new EnhancedPasteController({
			write: data => this.ctx.ui.terminal.write(data),
			pasteText: text => {
				const focused = this.ctx.ui.getFocused();
				const target = focused && focused !== this.ctx.editor && hasPasteText(focused) ? focused : this.ctx.editor;
				target.pasteText(text);
				this.ctx.ui.requestRender();
			},
			pasteImage: async image => {
				const focused = this.ctx.ui.getFocused();
				if (focused && focused !== this.ctx.editor && hasPasteText(focused)) {
					this.ctx.showStatus("Image paste is not supported in this prompt");
					return;
				}
				await this.#normalizeAndInsertPastedImage(image, `Unsupported pasted image format: ${image.mimeType}`);
			},
			showStatus: message => this.ctx.showStatus(message),
		});
		this.ctx.ui.addInputListener(data => (this.#enhancedPaste?.handleInput(data) ? { consume: true } : undefined));
		this.ctx.ui.addStartListener(() => this.#enhancedPaste?.enable());
	}

	#compactDraftImages(text: string): string {
		const editor = this.ctx.editor;
		const compacted = compactImageMarkers(text, editor.pendingImages.length);
		if (!compacted) return text;
		editor.pendingImages = compacted.keep.map(i => editor.pendingImages[i]);
		editor.pendingImageLinks = compacted.keep.map(i => editor.pendingImageLinks[i]);
		editor.imageLinks = editor.pendingImageLinks.length > 0 ? editor.pendingImageLinks : undefined;
		return compacted.text.trim();
	}

	setupEditorSubmitHandler(): void {
		this.ctx.editor.onSubmit = async (text: string) => {
			text = this.#compactDraftImages(text.trim());
			const hasPendingImages = this.ctx.editor.pendingImages.length > 0;
			if ((!isSettingsInitialized() || settings.get("emojiAutocomplete")) && text) text = expandEmoticons(text);

			if (this.ctx.focusedAgentId) {
				await this.#submitToFocusedSession(text, "steer");
				return;
			}

			if (!text && !hasPendingImages && this.ctx.session.isStreaming) {
				if (this.ctx.session.queuedMessageCount > 0) {
					const aborting = this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
					await aborting;
					this.ctx.updatePendingMessagesDisplay();
					this.ctx.ui.requestRender();
				}
				return;
			}

			if (!text && !hasPendingImages) return;

			if (text === "." || text === "c") {
				await this.ctx.ensureLatestTranscriptWindow();
				if (this.ctx.onInputCallback) {
					this.ctx.editor.clearDraft();
					this.ctx.onInputCallback({
						text: manualContinuePrompt,
						cancelled: false,
						started: true,
						synthetic: true,
						userInitiated: true,
					});
				}
				return;
			}

			const runner = this.ctx.session.extensionRunner;
			let inputImages = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
			let inputImageLinks =
				this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
			let hasInputImages = (inputImages?.length ?? 0) > 0;
			const submittedImages = inputImages;

			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, inputImages, "interactive");
				if (result?.handled) {
					this.ctx.editor.clearDraft();
					return;
				}
				if (result?.text !== undefined) {
					text = result.text.trim();
				}
				if (result?.images !== undefined) {
					inputImages = result.images;
					inputImageLinks = await materializeImageReferenceLinks(
						inputImages,
						this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager),
					);
				}
				hasInputImages = (inputImages?.length ?? 0) > 0;
			}
			const submittedMode = parseSlashCommand(text)?.name;
			const draftDetached = submittedMode === "goal";
			if (
				draftDetached &&
				submittedImages?.length &&
				submittedImages.every((image, index) => this.ctx.editor.pendingImages[index] === image)
			) {
				this.ctx.editor.pendingImages.splice(0, submittedImages.length);
				this.ctx.editor.pendingImageLinks.splice(0, submittedImages.length);
				this.ctx.editor.imageLinks =
					this.ctx.editor.pendingImageLinks.length > 0 ? this.ctx.editor.pendingImageLinks : undefined;
			}

			if (!text && !hasInputImages) return;

			const queueBody = parseQueueShorthand(text);
			if (queueBody !== undefined) {
				await this.#queueForYield(queueBody, {
					historyText: text,
					images: inputImages,
					imageLinks: inputImageLinks,
				});
				return;
			}

			if (text) {
				this.#recordSlashCommandUsage(text);
				if (parseSlashCommand(text)?.name !== "history") await this.ctx.ensureLatestTranscriptWindow();
				const input =
					(inputImages?.length ?? 0) > 0 || (inputImageLinks?.length ?? 0) > 0
						? { images: inputImages, imageLinks: inputImageLinks }
						: undefined;
				const slashResult = await executeBuiltinSlashCommand(text, { ctx: this.ctx, input, draftDetached });
				if (slashResult === true) {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					return;
				}
				if (typeof slashResult === "string") {
					if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
					text = slashResult;
				}
			}

			if (!text) await this.ctx.ensureLatestTranscriptWindow();

			if (text && isKnownSkillCommand(this.ctx, text)) {
				if (this.ctx.session.isCompacting) {
					const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
					this.ctx.queueCompactionMessage(text, "steer", images);
					return;
				}
				if (await this.#invokeSkillCommand(text, "steer", inputImages, inputImageLinks)) {
					return;
				}
			}

			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.ctx.session.isBashRunning) {
						this.ctx.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handleBashCommand(command, isExcluded);
					this.ctx.isBashMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			const pythonCommand = parsePythonCommandInput(text);
			if (pythonCommand) {
				const { code, isExcluded } = pythonCommand;
				if (code) {
					if (this.ctx.session.isEvalRunning) {
						this.ctx.showWarning("A Python execution is already running. Press Esc to cancel it first.");
						this.ctx.editor.setText(text);
						return;
					}
					this.ctx.editor.addToHistory(text);
					await this.ctx.handlePythonCommand(code, isExcluded);
					this.ctx.isPythonMode = false;
					this.ctx.updateEditorBorderColor();
					return;
				}
			}

			if (this.ctx.loopModeEnabled) {
				this.ctx.setLoopPrompt(text);
			}

			if (this.ctx.session.isCompacting) {
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.queueCompactionMessage(text, "steer", images);
				return;
			}

			if (this.#isLocalExtensionCommand(text)) {
				this.ctx.editor.clearDraft(text);
				try {
					await this.ctx.session.prompt(text, { images: inputImages });
				} catch (error) {
					if (inputImages && inputImages.length > 0) {
						this.ctx.editor.pendingImages = [...inputImages];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: inputImages.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.editor.setCollapsedText(text);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				return;
			}

			if (this.ctx.session.isStreaming) {
				this.ctx.editor.addToHistory(text);
				this.ctx.editor.setText("");
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];

				try {
					await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{ imageCount: images?.length ?? 0 },
					);
				} catch (error) {
					if (images && images.length > 0) {
						this.ctx.editor.pendingImages = [...images];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: images.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.editor.setCollapsedText(text);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
				return;
			}

			this.ctx.flushPendingBashComponents();

			if (this.ctx.onInputCallback) {
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];

				const submission = this.ctx.startPendingSubmission({
					text,
					images,
					imageLinks: inputImageLinks,
					streamingBehavior: "steer",
				});

				this.#maybeStartTitleGeneration(text);

				this.ctx.onInputCallback(submission);
			} else {
				this.ctx.editor.imageLinks = undefined;
				const images = inputImages && inputImages.length > 0 ? [...inputImages] : undefined;
				this.ctx.editor.pendingImages = [];
				this.ctx.editor.pendingImageLinks = [];
				this.#maybeStartTitleGeneration(text);
				try {
					await this.ctx.withLocalSubmission(
						text,
						() => this.ctx.session.prompt(text, { streamingBehavior: "steer", images }),
						{
							imageCount: images?.length ?? 0,
						},
					);
				} catch (error) {
					if (images && images.length > 0) {
						this.ctx.editor.pendingImages = [...images];
						this.ctx.editor.pendingImageLinks = inputImageLinks
							? [...inputImageLinks]
							: images.map(() => undefined);
						this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
					}
					this.ctx.editor.setCollapsedText(text);
					this.ctx.showError(error instanceof Error ? error.message : String(error));
				}
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			this.ctx.editor.addToHistory(text);
		};
	}

	#isLocalExtensionCommand(text: string): boolean {
		const extensionCommandSpace = text.indexOf(" ");
		return (
			text.startsWith("/") &&
			this.ctx.session.extensionRunner?.getCommand(
				extensionCommandSpace === -1 ? text.slice(1) : text.slice(1, extensionCommandSpace),
			) !== undefined
		);
	}

	#maybeStartTitleGeneration(text: string): void {
		if (this.#isLocalExtensionCommand(text)) {
			return;
		}
		this.ctx.session.maybeStartTitleGeneration(text, () => {
			this.#showTinyTitleDownloadProgress(this.ctx.settings.get("providers.tinyModel"));
		});
	}

	async #submitToFocusedSession(text: string, streamingBehavior: "steer" | "followUp"): Promise<void> {
		const target = this.ctx.viewSession;
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		if (!text && !images) {
			if (target.isStreaming && target.queuedMessageCount > 0) {
				const aborting = target.abort({ reason: USER_INTERRUPT_LABEL });
				await aborting;
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
			return;
		}
		if (text && (text.startsWith("/") || text.startsWith("!") || parsePythonCommandInput(text))) {
			this.ctx.showStatus("Commands run in the main session — press ←← to return first");
			return;
		}
		this.ctx.editor.clearDraft(text);
		try {
			await this.ctx.withLocalSubmission(text, () => target.prompt(text, { streamingBehavior, images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			if (images && images.length > 0) {
				this.ctx.editor.pendingImages = [...images];
				this.ctx.editor.pendingImageLinks = imageLinks ? [...imageLinks] : images.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
			this.ctx.editor.setCollapsedText(text);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.ui.requestRender();
	}

	handleCtrlC(): void {
		try {
			this.ctx.sessionManager.flushSync();
		} catch (err) {
			logger.warn("session-manager sync flush on Ctrl+C failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}

		if (this.ctx.isShuttingDown) {
			process.exit(130);
		}

		const now = Date.now();
		if (now - this.ctx.lastSigintTime < 500) {
			void this.ctx.shutdown();
		} else {
			this.ctx.clearEditor();
			this.ctx.lastSigintTime = now;
		}
	}

	handleCtrlD(): void {
		void this.ctx.shutdown();
	}

	handleCtrlZ(): void {
		const onResume = (): void => {
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
		};
		process.once("SIGCONT", onResume);

		this.ctx.ui.stop();

		try {
			process.kill(0, "SIGSTOP");
		} catch (err) {
			process.removeListener("SIGCONT", onResume);
			this.ctx.ui.start();
			this.ctx.ui.requestRender(true);
			const reason = err instanceof Error ? err.message : String(err);
			this.ctx.showError(`Failed to suspend: ${reason}`);
		}
	}

	handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.ctx.showStatus("No queued messages to restore");
		} else {
			this.ctx.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	async #invokeSkillCommand(
		text: string,
		streamingBehavior: "steer" | "followUp",
		images?: ImageContent[],
		imageLinks?: (string | undefined)[],
	): Promise<boolean> {
		if (!isKnownSkillCommand(this.ctx, text)) return false;
		const draftImages = images && images.length > 0 ? [...images] : undefined;
		const draftImageLinks = draftImages && imageLinks && imageLinks.length > 0 ? [...imageLinks] : undefined;
		const restoreDraft = () => {
			this.ctx.editor.setText(text);
			if (draftImages && draftImages.length > 0) {
				this.ctx.editor.pendingImages = [...draftImages];
				this.ctx.editor.pendingImageLinks = draftImageLinks
					? [...draftImageLinks]
					: draftImages.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}
		};

		this.ctx.editor.clearDraft(text);
		let optimistic = false;
		try {
			const built = await buildSkillCommandPrompt(this.ctx, text, streamingBehavior, draftImages);
			if (!built) {
				restoreDraft();
				return false;
			}

			optimistic = !this.ctx.session.isStreaming;
			if (optimistic) {
				this.ctx.renderOptimisticSkillMessage(
					{ role: "custom", ...built.message, timestamp: Date.now() },
					{ imageLinks: draftImageLinks },
				);
			}
			await this.ctx.session.promptCustomMessage(built.message, built.options);
			return true;
		} catch (error) {
			if (optimistic) this.ctx.clearOptimisticSkillMessage();
			restoreDraft();
			this.ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			if (optimistic && this.ctx.optimisticSkillMessagePending) {
				this.ctx.clearOptimisticSkillMessage();
			}
			if (this.ctx.session.isStreaming) {
				this.ctx.updatePendingMessagesDisplay();
				this.ctx.ui.requestRender();
			}
		}
	}

	async handleQueueCommand(text: string): Promise<void> {
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		await this.#queueForYield(text, { images, imageLinks });
	}

	async #queueForYield(
		text: string,
		options: {
			historyText?: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
		},
	): Promise<void> {
		const splitMessages = splitQueuedMessages(text);
		if (splitMessages.length === 0 && !options.images?.length) {
			this.ctx.editor.clearDraft();
			this.ctx.showWarning("Usage: /queue <message> (or start a prompt with -> / =>)");
			return;
		}

		const messages = splitMessages.length > 0 ? splitMessages : [""];
		const originalDraft = this.ctx.editor.getText();
		const images = options.images?.length ? [...options.images] : undefined;
		const imageLinks = options.imageLinks
			? [...options.imageLinks]
			: images
				? images.map(() => undefined)
				: undefined;
		this.ctx.editor.clearDraft(options.historyText);

		if (this.ctx.session.isCompacting) {
			for (let index = 0; index < messages.length; index++) {
				this.ctx.compactionQueuedMessages.push({
					text: messages[index] ?? "",
					mode: "followUp",
					images: index === 0 ? images : undefined,
				});
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showStatus(
				messages.length === 1
					? "Queued message for after compaction"
					: `Queued ${messages.length} messages for after compaction`,
			);
			this.ctx.ui.requestRender();
			return;
		}

		const startImmediately = !this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0;
		let queuedCount = 0;
		try {
			if (startImmediately && this.ctx.onInputCallback) {
				const first = messages[0] ?? "";
				const submission = this.ctx.startPendingSubmission({
					text: first,
					images,
					imageLinks,
					streamingBehavior: "followUp",
				});
				this.ctx.onInputCallback(submission);
				queuedCount = 1;
			}
			while (queuedCount < messages.length) {
				const message = messages[queuedCount] ?? "";
				const queuedImages = queuedCount === 0 ? images : undefined;
				await this.ctx.withLocalSubmission(
					message,
					async () => {
						if (startImmediately && queuedCount === 0) {
							await this.ctx.session.prompt(message, {
								images: queuedImages,
								streamingBehavior: "followUp",
							});
						} else {
							await this.ctx.session.followUp(message, queuedImages);
						}
					},
					{ imageCount: queuedImages?.length ?? 0 },
				);
				queuedCount++;
			}
		} catch (error) {
			if (queuedCount === 0) {
				this.ctx.editor.setText(originalDraft);
				if (images) {
					this.ctx.editor.pendingImages = images;
					this.ctx.editor.pendingImageLinks = imageLinks ?? images.map(() => undefined);
					this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
				}
			} else {
				const remaining = messages.slice(queuedCount);
				const restored =
					remaining.length === 1
						? `=> ${remaining[0]}`
						: `=>\n${remaining
								.map((message, index) => `${index + 1}. ${message.replaceAll("\n", "\n   ")}`)
								.join("\n")}`;
				this.ctx.editor.setText(restored);
			}
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}

		this.ctx.updatePendingMessagesDisplay();
		if (queuedCount === messages.length) {
			this.ctx.showStatus(
				startImmediately
					? queuedCount === 1
						? "Sent queued message"
						: `Sent first message; queued ${queuedCount - 1} for later yields`
					: queuedCount === 1
						? "Queued message for when the agent yields"
						: `Queued ${queuedCount} messages for when the agent yields`,
			);
		}
		this.ctx.ui.requestRender();
	}

	async handleFollowUp(): Promise<void> {
		let text = this.#compactDraftImages(this.ctx.editor.getExpandedText().trim());
		const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
		const imageLinks =
			images && this.ctx.editor.pendingImageLinks.length > 0 ? [...this.ctx.editor.pendingImageLinks] : undefined;
		if (!text && !images) return;

		if (this.ctx.focusedAgentId) {
			await this.#submitToFocusedSession(text, "followUp");
			return;
		}

		if (this.ctx.session.isCompacting) {
			const images = this.ctx.editor.pendingImages.length > 0 ? [...this.ctx.editor.pendingImages] : undefined;
			this.ctx.queueCompactionMessage(text, "followUp", images);
			return;
		}

		if (text) {
			const input = (images?.length ?? 0) > 0 || (imageLinks?.length ?? 0) > 0 ? { images, imageLinks } : undefined;
			const slashResult = await executeBuiltinSlashCommand(text, { ctx: this.ctx, input });
			if (slashResult === true) {
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				return;
			}
			if (typeof slashResult === "string") {
				if (!shouldSkipHistory(text)) this.ctx.editor.addToHistory(text);
				text = slashResult;
			}
		}

		if (text && (await this.#invokeSkillCommand(text, "followUp", images, imageLinks))) {
			return;
		}

		const restoreOnError = (error: unknown) => {
			if (images && images.length > 0) {
				this.ctx.editor.pendingImages = [...images];
				this.ctx.editor.pendingImageLinks = imageLinks ? [...imageLinks] : images.map(() => undefined);
				this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
			}

			this.ctx.editor.setCollapsedText(text);
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		};

		if (this.ctx.session.isStreaming) {
			this.ctx.editor.clearDraft(text);
			try {
				await this.ctx.withLocalSubmission(
					text,
					() => this.ctx.session.prompt(text, { streamingBehavior: "followUp", images }),
					{ imageCount: images?.length ?? 0 },
				);
			} catch (error) {
				restoreOnError(error);
			}
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.ui.requestRender();
			return;
		}

		this.ctx.editor.clearDraft(text);
		try {
			await this.ctx.withLocalSubmission(text, () => this.ctx.session.prompt(text, { images }), {
				imageCount: images?.length ?? 0,
			});
		} catch (error) {
			restoreOnError(error);
		}
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();

		const { steering, followUp } = this.ctx.session.clearQueue({ forInterrupt: options?.abort });

		const compactionQueued = this.ctx.compactionQueuedMessages;
		this.ctx.compactionQueuedMessages = [];
		const allQueued = [
			...steering,
			...compactionQueued.filter(e => e.mode === "steer").map(e => ({ text: e.text, images: e.images })),
			...followUp,
			...compactionQueued.filter(e => e.mode === "followUp").map(e => ({ text: e.text, images: e.images })),
		];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
			}
			return 0;
		}

		const queuedImages = allQueued.flatMap(e => e.images ?? []);
		let queuedText: string;
		if (queuedImages.length > 0) {
			const parts: string[] = [];
			let imageOffset = this.ctx.editor.pendingImages.length;
			for (const entry of allQueued) {
				parts.push(shiftImageMarkers(entry.text, imageOffset));
				if (entry.images && entry.images.length > 0) imageOffset += entry.images.length;
			}
			queuedText = parts.join("\n\n");
		} else {
			queuedText = allQueued.map(e => e.text).join("\n\n");
		}
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");

		if (queuedImages.length > 0) {
			this.ctx.editor.pendingImages.push(...queuedImages);
			this.ctx.editor.pendingImageLinks.push(...queuedImages.map(() => undefined));
			this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		}
		this.ctx.editor.setCollapsedText(combinedText);
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			void this.ctx.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		return allQueued.length;
	}

	async #insertPendingImage(imageData: ImageContent): Promise<void> {
		const image: ImageContent = { type: "image", data: imageData.data, mimeType: imageData.mimeType };
		const imageLink = (
			await materializeImageReferenceLinks([image], this.ctx.sessionManager.putBlob.bind(this.ctx.sessionManager))
		)?.[0];
		this.ctx.editor.pendingImages.push(image);
		this.ctx.editor.pendingImageLinks.push(imageLink);
		this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		const imageNum = this.ctx.editor.pendingImages.length;
		const dims = await this.#imageDimensions(imageData);
		setCachedImageDimensions(image, dims ?? null);

		const expansion = dims ? `[Image #${imageNum}, ${dims.width}x${dims.height}]` : `[Image #${imageNum}]`;
		this.ctx.editor.insertAtom(chipLabel("image", imageNum), expansion);
		this.ctx.ui.requestRender();
	}

	async #imageDimensions(image: ImageContent): Promise<{ width: number; height: number } | undefined> {
		try {
			const { width, height } = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
			if (width && height) return { width, height };
		} catch {}
		return undefined;
	}

	async #normalizeAndInsertPastedImage(image: ImageContent, unsupportedMessage: string): Promise<boolean> {
		let imageData = await ensureSupportedImageInput(image);
		if (!imageData) {
			this.ctx.showStatus(unsupportedMessage);
			return false;
		}
		if (settings.get("images.autoResize")) {
			try {
				const resized = await resizeImage({
					type: "image",
					data: imageData.data,
					mimeType: imageData.mimeType,
				});
				imageData = { type: "image", data: resized.data, mimeType: resized.mimeType };
			} catch {}
		}
		await this.#insertPendingImage(imageData);
		return true;
	}

	async #tryPasteClipboardImage(): Promise<boolean> {
		const env = process.env;
		if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
		try {
			const image = await this.clipboard.readImage();
			if (!image) return false;
			await this.#normalizeAndInsertPastedImage(
				{ type: "image", data: image.data.toBase64(), mimeType: image.mimeType },
				`Unsupported clipboard image format: ${image.mimeType}`,
			);
			return true;
		} catch {
			return false;
		}
	}

	async handleImagePathPaste(path: string): Promise<void> {
		try {
			const image = await loadImageInput({
				path,
				cwd: this.ctx.sessionManager.getCwd(),
				autoResize: false,
			});
			if (!image) {
				if (await this.#tryPasteClipboardImage()) return;
				this.ctx.editor.pasteText(path);
				this.ctx.ui.requestRender();
				this.ctx.showStatus("Pasted path is not a supported image");
				return;
			}
			await this.#normalizeAndInsertPastedImage(
				{ type: "image", data: image.data, mimeType: image.mimeType },
				`Unsupported pasted image format: ${image.mimeType}`,
			);
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				this.ctx.editor.pasteText(path);
				this.ctx.ui.requestRender();
				this.ctx.showStatus(error.message);
				return;
			}
			if (isEnoent(error)) {
				if (await this.#tryPasteClipboardImage()) return;

				const env = process.env;
				const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
				const displayPath = truncateToWidth(
					shortenPath(
						sanitizeText(path)
							.replace(/[\r\n\t]+/g, " ")
							.trim(),
					),
					TRUNCATE_LENGTHS.CONTENT,
				);
				this.ctx.showStatus(
					overSsh
						? `Image not found at ${displayPath}. Over SSH this path is local to your terminal — paste the image directly (clipboard image-paste shortcut) to send its bytes.`
						: `Image not found at ${displayPath}`,
				);
				return;
			}
			if (await this.#tryPasteClipboardImage()) return;
			this.ctx.editor.pasteText(path);
			this.ctx.ui.requestRender();
			this.ctx.showStatus("Failed to read pasted image path");
		}
	}

	async handleImagePaste(): Promise<boolean> {
		try {
			const focusedNow = this.ctx.ui.getFocused();
			const promptTarget =
				focusedNow && focusedNow !== this.ctx.editor && hasPasteText(focusedNow) ? focusedNow : null;

			const fileUrls = promptTarget ? [] : ((await this.clipboard.readMacFileUrls?.()) ?? []);
			let attachedFromFileUrls = false;
			for (const url of fileUrls) {
				const candidate = extractImagePathFromText(url);
				if (!candidate) continue;
				await this.handleImagePathPaste(candidate);
				attachedFromFileUrls = true;
			}
			if (attachedFromFileUrls) return true;

			const image = await this.clipboard.readImage();
			if (image) {
				if (promptTarget) {
					this.ctx.showStatus("Image paste is not supported in this prompt");
					return false;
				}
				return await this.#normalizeAndInsertPastedImage(
					{
						type: "image",
						data: image.data.toBase64(),
						mimeType: image.mimeType,
					},
					`Unsupported clipboard image format: ${image.mimeType}`,
				);
			}

			const text = await this.clipboard.readText();
			if (!text) {
				this.ctx.showStatus("Clipboard is empty");
				return false;
			}

			const imagePath = promptTarget ? null : extractImagePathFromText(text);
			if (imagePath) {
				await this.handleImagePathPaste(imagePath);
				return true;
			}

			const target = promptTarget ?? this.ctx.editor;
			target.pasteText(text);
			this.ctx.ui.requestRender();
			return true;
		} catch {
			this.ctx.showStatus("Failed to read clipboard");
			return false;
		}
	}

	async handleClipboardTextRawPaste(): Promise<void> {
		try {
			const text = await this.clipboard.readText();
			if (text) {
				this.ctx.editor.insertText(text);
				this.ctx.ui.requestRender();
			} else {
				this.ctx.showStatus("No text in clipboard to paste raw");
			}
		} catch {
			this.ctx.showStatus("Failed to paste raw text from clipboard");
		}
	}

	handleLargePaste(text: string, lineCount: number): boolean {
		const threshold = this.ctx.settings.get("paste.largeMenuThreshold");
		if (!(threshold > 0) || lineCount < threshold) {
			this.ctx.editor.insertTextAttachment(text);
			return true;
		}
		void this.presentLargePasteMenu(text, lineCount);
		return true;
	}

	async presentLargePasteMenu(text: string, lineCount: number): Promise<void> {
		const WRAPPED_BLOCK = "Attach as a wrapped block";
		const LOCAL_FILE = "Attach as local file";
		const INLINE = "Paste inline";

		let choice: string | undefined;
		try {
			choice = await this.ctx.showHookSelector(
				`Pasted ${lineCount} lines`,
				[
					{ label: WRAPPED_BLOCK, description: "Wrap the text in <attachment> tags, collapsed to a marker" },
					{ label: LOCAL_FILE, description: "Save the text to a local://paste file" },
					{ label: INLINE, description: "Collapse the text to an inline paste marker" },
				],
				{ helpText: "Esc to paste inline" },
			);
		} catch (error) {
			logger.warn("large-paste menu failed", { error: error instanceof Error ? error.message : String(error) });
			choice = undefined;
		}

		switch (choice) {
			case WRAPPED_BLOCK:
				this.ctx.editor.insertTextAttachment(text, wrapPasteInAttachmentBlock(text));
				break;
			case LOCAL_FILE:
				await this.#attachPasteAsFile(text, lineCount);
				break;
			case INLINE:
				this.ctx.editor.insertTextAttachment(text);
				break;
			default:
				this.ctx.editor.insertTextAttachment(text);
				break;
		}
		this.ctx.ui.requestRender();
	}

	async #attachPasteAsFile(text: string, lineCount: number): Promise<void> {
		try {
			const localRoot = resolveLocalRoot({
				getArtifactsDir: () => this.ctx.sessionManager.getArtifactsDir(),
				getSessionId: () => this.ctx.sessionManager.getSessionId(),
			});
			let name: string;
			let filePath: string;
			do {
				this.#pasteCounter++;
				name = `paste-${this.#pasteCounter}.md`;
				filePath = path.join(localRoot, name);
			} while (await Bun.file(filePath).exists());
			await Bun.write(filePath, text);
			this.ctx.editor.insertText(`local://${name} `);
			this.ctx.showStatus(`Saved ${lineCount} pasted lines to local://${name}`);
		} catch (error) {
			logger.warn("failed to save large paste to file", {
				error: error instanceof Error ? error.message : String(error),
			});
			this.ctx.editor.insertTextAttachment(text);
			this.ctx.showError("Failed to save paste to a file — attached as a text chip instead");
		}
	}

	#recordSlashCommandUsage(text: string): void {
		if (!text.startsWith("/")) return;
		const token = text.slice(1).split(/\s+/, 1)[0] ?? "";
		if (!token) return;
		const session = this.ctx.session;
		const knownToken =
			this.ctx.skillCommands.has(token) ||
			this.ctx.fileSlashCommands.has(token) ||
			session.extensionRunner?.getCommand(token) !== undefined ||
			session.customCommands.some(loaded => loaded.command.name === token) ||
			session.promptTemplates.some(template => template.name === token);
		if (knownToken) {
			recordSlashCommandUsage(token);
			return;
		}
		const parsedName = parseSlashCommand(text)?.name;
		const builtin = parsedName ? lookupBuiltinSlashCommand(parsedName) : undefined;
		if (builtin) recordSlashCommandUsage(builtin.name);
	}

	createAutocompleteProvider(commands: SlashCommand[], basePath: string): AutocompleteProvider {
		void loadSlashCommandUsage();
		return createPromptActionAutocompleteProvider({
			commands,
			basePath,
			commandUsage: getSlashCommandUsage,
			keybindings: this.ctx.keybindings,
			copyCurrentLine: () => this.handleCopyCurrentLine(),
			copyPrompt: () => this.handleCopyPrompt(),
			undo: prefix => this.ctx.editor.undoPastTransientText(prefix),
			moveCursorToMessageEnd: () => this.ctx.editor.moveToMessageEnd(),
			moveCursorToMessageStart: () => this.ctx.editor.moveToMessageStart(),
			moveCursorToLineStart: () => this.ctx.editor.moveToLineStart(),
			moveCursorToLineEnd: () => this.ctx.editor.moveToLineEnd(),
		});
	}

	handleCopyCurrentLine(): void {
		const { line } = this.ctx.editor.getCursor();
		const text = this.ctx.editor.getLines()[line] || "";
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied line: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	handleCopyPrompt(): void {
		const text = this.ctx.editor.getText();
		if (!text) {
			this.ctx.showStatus("Nothing to copy");
			return;
		}
		try {
			copyToClipboard(text);
			const sanitized = sanitizeText(text);
			const preview = sanitized.length > 30 ? `${sanitized.slice(0, 30)}...` : sanitized;
			this.ctx.showStatus(`Copied: ${preview}`);
		} catch {
			this.ctx.showWarning("Failed to copy to clipboard");
		}
	}

	cycleThinkingLevel(): void {
		if (this.ctx.focusedAgentId) {
			this.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
			return;
		}
		const newLevel = this.ctx.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.ctx.showStatus("Current model does not support thinking");
		} else {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}
	}

	async cycleRoleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
		if (this.ctx.focusedAgentId) {
			this.ctx.showStatus("Model/thinking apply to the main session — press ←← to return first");
			return;
		}
		try {
			const cycleOrder = settings.get("cycleOrder");
			const result = await this.ctx.session.cycleRoleModels(cycleOrder, direction);
			if (!result) {
				this.ctx.showStatus("Only one role model available");
				return;
			}

			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();

			const track = renderSegmentTrack(
				cycleOrder.map(role => ({ label: role })),
				cycleOrder.indexOf(result.role),
			);
			this.ctx.showModelCycleTrack(track);
		} catch (error) {
			this.ctx.showError(error instanceof Error ? error.message : String(error));
		}
	}

	toggleToolOutputExpansion(): void {
		if (this.ctx.hideToolActivity) {
			const visibilityKey = this.ctx.keybindings.getDisplayString("app.tools.toggleVisibility");
			const visibilityHint = visibilityKey ? `${visibilityKey} or /settings` : "/settings";
			this.ctx.showStatus(`Tool activity is hidden — show it with ${visibilityHint} before expanding`);
			return;
		}
		this.setToolsExpanded(!this.ctx.toolOutputExpanded);
	}

	toggleToolActivityVisibility(): void {
		this.ctx.hideToolActivity = !this.ctx.hideToolActivity;
		this.ctx.settings.set("display.hideToolActivity", this.ctx.hideToolActivity);

		if (!this.ctx.hideToolActivity) {
			this.ctx.toolOutputExpanded = false;
		}

		for (const child of this.ctx.chatContainer.children) {
			if (
				!this.ctx.hideToolActivity &&
				(child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent)
			) {
				child.setExpanded(false);
			} else if (child instanceof AssistantMessageComponent) {
				child.setToolResultImagesVisible(!this.ctx.hideToolActivity);
			}
		}
		this.ctx.chatContainer.setToolActivityVisible(!this.ctx.hideToolActivity);

		if (this.ctx.hideToolActivity) this.ctx.ui.clearInlineImages();
		this.ctx.ui.resetDisplay();
		this.ctx.showStatus(`Tool activity: ${this.ctx.hideToolActivity ? "hidden" : "visible"}`);
	}

	setToolsExpanded(expanded: boolean): void {
		this.ctx.toolOutputExpanded = expanded;
		for (const child of this.ctx.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}

		this.ctx.ui.resetDisplay();
	}

	toggleThinkingBlockVisibility(): void {
		const thinkingOff =
			((this.ctx.viewSession ?? this.ctx.session)?.thinkingLevel ?? ThinkingLevel.Off) === ThinkingLevel.Off;
		if (thinkingOff && !this.ctx.hasDisplayableThinkingContent) {
			this.ctx.showStatus("Thinking is off — enable thinking to show blocks");
			return;
		}
		this.ctx.hideThinkingBlock = !this.ctx.hideThinkingBlock;
		this.ctx.settings.set("hideThinkingBlock", this.ctx.hideThinkingBlock);

		for (const child of this.ctx.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			}
		}

		if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.hideThinkingBlock);
			this.ctx.streamingComponent.updateContent(this.ctx.streamingMessage);
		}

		this.ctx.ui.resetDisplay();

		this.ctx.showStatus(`Thinking blocks: ${this.ctx.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	async openExternalEditor(): Promise<void> {
		const editorCmd = getEditorCommand();
		if (!editorCmd) {
			this.ctx.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.ctx.editor.getExpandedText?.() ?? this.ctx.editor.getText();

		try {
			this.ctx.ui.stop();
			const result = await openInEditor(editorCmd, currentText, { extension: ".proto.md" });
			if (result !== null) {
				this.ctx.editor.setText(result);
			}
		} catch (error) {
			this.ctx.showWarning(
				`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.ctx.ui.start();
			this.ctx.ui.requestRender();
		}
	}

	registerExtensionShortcuts(): void {
		const runner = this.ctx.session.extensionRunner;
		if (!runner) return;

		const shortcuts = runner.getShortcuts();
		for (const [keyId, shortcut] of shortcuts) {
			this.ctx.editor.setCustomKeyHandler(keyId, () => {
				const ctx = runner.createCommandContext();
				try {
					shortcut.handler(ctx);
				} catch (err) {
					runner.emitError({
						extensionPath: shortcut.extensionPath,
						event: "shortcut",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			});
		}
	}
}
