import type { Component } from "@oh-my-pi/pi-tui";
import { Box, Container } from "@oh-my-pi/pi-tui";
import type { HookMessageRenderer } from "../../extensibility/hooks/types";
import { theme } from "../../modes/theme/theme";
import type { HookMessage } from "../../session/messages";
import { renderFramedMessage } from "./message-frame";

const HOOK_COLLAPSED_LINES = 5;

export class HookMessageComponent extends Container {
	#box: Box;
	#customComponent?: Component;
	#expanded = false;

	constructor(
		private readonly message: HookMessage<unknown>,
		private readonly customRenderer?: HookMessageRenderer,
	) {
		super();

		this.#box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		this.#box.setIgnoreTight(true);

		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		if (this.#customComponent) {
			this.removeChild(this.#customComponent);
			this.#customComponent = undefined;
		}
		this.removeChild(this.#box);

		const custom = renderFramedMessage({
			message: this.message,
			box: this.#box,
			expanded: this.#expanded,
			customRenderer: this.customRenderer,
			collapseAfterLines: HOOK_COLLAPSED_LINES,
		});

		if (custom) {
			this.#customComponent = custom;
			this.addChild(custom);
		} else {
			this.addChild(this.#box);
		}
	}
}
