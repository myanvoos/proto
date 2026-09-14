import { getKeybindings } from "../keybindings";
import { Loader } from "./loader";

export class CancellableLoader extends Loader {
	#abortController = new AbortController();

	onAbort?: () => void;

	get signal(): AbortSignal {
		return this.#abortController.signal;
	}

	get aborted(): boolean {
		return this.#abortController.signal.aborted;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.#abortController.abort();
			this.onAbort?.();
		}
	}

	override dispose(): void {
		this.stop();
		// Disposal means the owned operation is dead: abort its signal so
		// in-flight work observes cancellation. The user-facing onAbort
		// callback stays reserved for explicit Esc handling.
		if (!this.#abortController.signal.aborted) {
			this.#abortController.abort();
		}
	}
}
