import {
	type Component,
	matchesKey,
	type OverlayFocusOwner,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { heroMeta, heroWordmark } from "../components/welcome";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import type { SetupScene, SetupSceneController, SetupSceneHost, SetupSceneResult } from "./scenes/types";

type WizardPhase = "scene" | "done";

const SCENE_MARGIN_X = 4;
const MIN_CONTENT_WIDTH = 20;

function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

function indentLine(line: string, width: number, indent: number): string {
	const prefix = padding(Math.min(indent, Math.max(0, width - 1)));
	return clampLine(prefix + line, width);
}

export class SetupWizardComponent implements Component, OverlayFocusOwner {
	#phase: WizardPhase = "scene";
	#sceneIndex = 0;
	#activeScene: SetupSceneController | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;

	#bodyRowStart = 0;
	#sceneFocusTarget: Component | undefined;

	constructor(
		readonly ctx: InteractiveModeContext,
		readonly scenes: readonly SetupScene[],
	) {}

	run(): Promise<void> {
		if (this.scenes.length === 0) {
			this.#complete();
		} else {
			this.#mountSceneController("scene");
		}
		this.ctx.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		this.#unmountActiveScene();
	}

	invalidate(): void {
		this.#activeScene?.invalidate?.();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		if (this.#sceneFocusTarget !== component) return false;
		return true;
	}

	handleInput(data: string): void {
		if (this.#phase === "done") return;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				this.#routeMouseEvent(event);
			});
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#complete();
			return;
		}
		this.#activeScene?.handleInput?.(data);
	}

	#routeMouseEvent(event: SgrMouseEvent): void {
		const scene = this.#activeScene;
		if (!scene) return;
		if (scene.routeMouse) {
			scene.routeMouse(event, event.row - this.#bodyRowStart, event.col - SCENE_MARGIN_X);
			return;
		}
		if (event.wheel !== null) {
			scene.handleInput?.(event.wheel === -1 ? "\x1b[A" : "\x1b[B");
		}
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.ctx.ui.terminal.rows);
		let lines: string[];
		switch (this.#phase) {
			case "scene":
				lines = this.#renderScene(safeWidth, height);
				break;
			case "done":
				lines = [];
				break;
		}
		return this.#fitToScreen(lines, safeWidth, height);
	}

	#heroInfo(): { version: string; modelName?: string; providerName?: string } {
		const model = this.ctx.session?.model;
		return { version: VERSION, modelName: model?.id, providerName: model?.provider };
	}

	#renderScene(width: number, height: number): string[] {
		const scene = this.scenes[this.#sceneIndex];
		const title = this.#activeScene?.title ?? scene?.title ?? "Setup";
		const subtitle = this.#activeScene?.subtitle;
		const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - SCENE_MARGIN_X * 2);
		const info = this.#heroInfo();
		const header = [
			"",
			centerLine(heroWordmark(), width),
			"",
			centerLine(heroMeta(info.version, info.modelName, info.providerName), width),
			centerLine(theme.fg("muted", `Setup step ${this.#sceneIndex + 1} of ${this.scenes.length}`), width),
			"",
			indentLine(theme.bold(title), width, SCENE_MARGIN_X),
		];
		if (subtitle) {
			header.push(indentLine(theme.fg("muted", subtitle), width, SCENE_MARGIN_X));
		}
		header.push("");
		this.#bodyRowStart = header.length;

		const footer = [
			"",
			centerLine(theme.fg("dim", "↑/↓ select · enter confirm · esc skip · ctrl+c exit setup"), width),
		];
		const maxBodyLines = Math.max(0, height - header.length - footer.length);
		const body = this.#activeScene?.render(contentWidth, maxBodyLines).slice(0, maxBodyLines) ?? [];
		const lines = [...header, ...body.map(line => indentLine(line, width, SCENE_MARGIN_X))];
		while (lines.length + footer.length < height) {
			lines.push("");
		}
		lines.push(...footer);
		return lines;
	}

	#fitToScreen(lines: string[], width: number, height: number): string[] {
		const fitted = lines.slice(0, height).map(line => clampLine(line, width));
		while (fitted.length < height) {
			fitted.push(padding(width));
		}
		return fitted;
	}

	#mountSceneController(targetPhase: "scene"): void {
		if (this.#disposed) return;
		this.#unmountActiveScene();
		if (this.#sceneIndex >= this.scenes.length) {
			this.#complete();
			return;
		}
		const scene = this.scenes[this.#sceneIndex];
		const host: SetupSceneHost = {
			ctx: this.ctx,
			requestRender: () => this.ctx.ui.requestRender(),
			finish: (_result: SetupSceneResult) => this.#finishScene(),
			setFocus: component => {
				this.#sceneFocusTarget = component ?? undefined;
				this.ctx.ui.setFocus(component);
			},
			restoreFocus: () => {
				this.#sceneFocusTarget = undefined;
				this.ctx.ui.setFocus(this);
			},
		};
		this.#activeScene = scene.mount(host);
		this.#phase = targetPhase;
		this.#sceneFocusTarget = undefined;
		this.ctx.ui.setFocus(this);
		void this.#activeScene.onMount?.();
		this.ctx.ui.requestRender();
	}

	#finishScene(): void {
		if (this.#phase !== "scene") return;
		this.#unmountActiveScene();
		this.#sceneIndex += 1;
		this.#mountSceneController("scene");
	}

	#unmountActiveScene(): void {
		this.#sceneFocusTarget = undefined;
		this.#activeScene?.onUnmount?.();
		this.#activeScene?.dispose?.();
		this.#activeScene = undefined;
	}

	#complete(): void {
		if (this.#phase === "done") return;
		this.#phase = "done";
		this.#done.resolve();
	}
}
