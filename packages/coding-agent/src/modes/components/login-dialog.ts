import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthPrompt } from "@oh-my-pi/pi-ai/oauth/types";
import { Container, getKeybindings, Input, Spacer, Text, type TUI, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { sanitizeDisplayText, sanitizeSingleLine } from "../../tools/render-utils";
import { safeHyperlinkUri, urlHyperlinkAlways, WidthAwareText } from "../../tui";
import * as open from "../../utils/open";
import { OverlayPanel } from "./overlay-box";

export class LoginDialogComponent extends OverlayPanel {
	#contentContainer: Container;
	#input: Input;
	#tui: TUI;
	#abortController = new AbortController();
	#inputResolver?: (value: string) => void;
	#inputRejecter?: (error: Error) => void;

	constructor(
		tui: TUI,
		providerId: string,
		private onComplete: (success: boolean, message?: string) => void,
	) {
		const providerInfo = getOAuthProviders().find(p => p.id === providerId);
		const providerName = providerInfo?.name || providerId;
		super(`Login to ${sanitizeSingleLine(providerName)}`);
		this.#tui = tui;

		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		this.#input = this.#createInput();
	}

	#createInput(): Input {
		const input = new Input();
		input.onSubmit = value => {
			const resolve = this.#inputResolver;
			if (!resolve) return;
			this.#clearInputHandlers();
			resolve(value);
		};
		input.onEscape = () => {
			this.#cancel();
		};
		return input;
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	#cancel(): void {
		this.#abortController.abort();
		const reject = this.#inputRejecter;
		this.#clearInputHandlers();
		reject?.(new Error("Login cancelled"));
		this.onComplete(false, "Login cancelled");
	}

	showAuth(url: string, instructions?: string, launchUrl?: string): void {
		this.#contentContainer.clear();
		this.#contentContainer.addChild(new Spacer(1));
		const displayUrl = sanitizeSingleLine(url);
		this.#contentContainer.addChild(
			new WidthAwareText(
				contentWidth =>
					wrapTextWithAnsi(displayUrl, contentWidth)
						.map(row => theme.fg("accent", urlHyperlinkAlways(url, row)))
						.join("\n"),
				0,
				0,
			),
		);

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const safeUrl = safeHyperlinkUri(url);
		const hyperlink = safeUrl
			? `\x1b]8;;${safeUrl}\x07${sanitizeSingleLine(clickHint)}\x1b]8;;\x07`
			: sanitizeSingleLine(clickHint);
		this.#contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 0, 0));

		if (launchUrl && launchUrl !== url) {
			this.#contentContainer.addChild(
				new Text(theme.fg("dim", `Local shortcut (this machine only): ${sanitizeSingleLine(launchUrl)}`), 0, 0),
			);
		}

		if (instructions) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("warning", sanitizeDisplayText(instructions)), 0, 0));
		}

		open.openPath(url);

		this.#tui.requestRender();
	}

	showManualInput(prompt: string): Promise<string> {
		// Keep retry chrome in place, but discard prior prompt undo/kill history.
		const mounted = this.#contentContainer.children.indexOf(this.#input);
		this.#input = this.#createInput();
		if (mounted !== -1) {
			this.#contentContainer.children.splice(mounted, 1, this.#input);
		} else {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", sanitizeDisplayText(prompt)), 0, 0));
			this.#contentContainer.addChild(this.#input);
			this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 0, 0));
		}
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	showPrompt(prompt: OAuthPrompt): Promise<string> {
		// Multi-step flows keep prior answers visible above the next prompt, except secrets.
		const mounted = this.#contentContainer.children.indexOf(this.#input);
		if (mounted !== -1) {
			const value = this.#input.mask ? "********" : sanitizeSingleLine(this.#input.getValue());
			const answer = new Text(theme.fg("dim", `${this.#input.prompt}${value}`), 0, 0);
			this.#contentContainer.removeChild(this.#input);
			this.#contentContainer.children.splice(mounted, 0, answer);
		}
		// A new prompt must not recover a previous secret through undo or yank.
		this.#input = this.#createInput();
		this.#input.mask = prompt.secret === true;
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("text", sanitizeDisplayText(prompt.message)), 0, 0));
		if (prompt.placeholder) {
			this.#contentContainer.addChild(
				new Text(theme.fg("dim", `e.g., ${sanitizeSingleLine(prompt.placeholder)}`), 0, 0),
			);
		}
		this.#contentContainer.addChild(this.#input);
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel, Enter to submit)"), 0, 0));

		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	#clearInputHandlers(): void {
		this.#inputResolver = undefined;
		this.#inputRejecter = undefined;
	}

	showWaiting(message: string): void {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("dim", sanitizeDisplayText(message)), 0, 0));
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 0, 0));
		this.#tui.requestRender();
	}

	showProgress(message: string): void {
		this.#contentContainer.addChild(new Text(theme.fg("dim", sanitizeDisplayText(message)), 0, 0));
		this.#tui.requestRender();
	}

	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.#cancel();
			return;
		}

		this.#input.handleInput(data);
	}
}
