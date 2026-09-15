import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
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

		this.#input = new Input();
		this.#input.onSubmit = () => {
			if (this.#inputResolver) {
				this.#inputResolver(this.#input.getValue());
				this.#inputResolver = undefined;
				this.#inputRejecter = undefined;
			}
		};
		this.#input.onEscape = () => {
			this.#cancel();
		};
	}

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	#cancel(): void {
		this.#abortController.abort();
		if (this.#inputRejecter) {
			this.#inputRejecter(new Error("Login cancelled"));
			this.#inputResolver = undefined;
			this.#inputRejecter = undefined;
		}
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
		if (!this.#contentContainer.children.includes(this.#input)) {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", sanitizeDisplayText(prompt)), 0, 0));
			this.#contentContainer.addChild(this.#input);
			this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel)"), 0, 0));
		}
		this.#input.setValue("");
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
	}

	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("text", sanitizeDisplayText(message)), 0, 0));
		if (placeholder) {
			this.#contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${sanitizeSingleLine(placeholder)}`), 0, 0));
		}
		if (!this.#contentContainer.children.includes(this.#input)) {
			this.#contentContainer.addChild(this.#input);
		}
		this.#contentContainer.addChild(new Text(theme.fg("dim", "(Escape to cancel, Enter to submit)"), 0, 0));

		this.#input.setValue("");
		this.#tui.requestRender();

		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#inputResolver = resolve;
		this.#inputRejecter = reject;
		return promise;
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
