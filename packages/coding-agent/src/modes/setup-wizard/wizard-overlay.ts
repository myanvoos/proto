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
import { BINARY_NAME } from "@oh-my-pi/pi-utils";
import { gradientLogo, PI_LOGO } from "../components/welcome";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { renderSetupOutro, SETUP_OUTRO_MS } from "./scenes/outro";
import type { SetupScene, SetupSceneController, SetupSceneHost, SetupSceneResult } from "./scenes/types";

type WizardPhase = "scene" | "outro" | "done";

const SCENE_MARGIN_X = 4;
const MIN_CONTENT_WIDTH = 20;
/** Outro completion poll cadence; the outro frame itself is static. */
const OUTRO_TICK_MS = 50;

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
	#phaseStartedAt = performance.now();
	#sceneIndex = 0;
	#activeScene: SetupSceneController | undefined;
	#timer: NodeJS.Timeout | undefined;
	#done = Promise.withResolvers<void>();
	#disposed = false;
	/** Screen row where the active scene's body began in the last rendered frame. */
	#bodyRowStart = 0;
	#sceneFocusTarget: Component | undefined;

	constructor(
		readonly ctx: InteractiveModeContext,
		readonly scenes: readonly SetupScene[],
	) {}

	run(): Promise<void> {
		if (this.scenes.length === 0) {
			this.#beginOutro();
		} else {
			this.#mountSceneController("scene");
		}
		this.#startTimer();
		this.ctx.ui.requestRender();
		return this.#done.promise;
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopTimer();
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
			this.#beginOutro();
			return;
		}
		if (this.#phase === "outro") {
			if (
				matchesKey(data, "enter") ||
				matchesKey(data, "return") ||
				matchesKey(data, "space") ||
				matchesKey(data, "escape")
			) {
				this.#complete();
			}
			return;
		}
		this.#activeScene?.handleInput?.(data);
	}

	/**
	 * Mouse handling for the fullscreen wizard (SGR tracking is on while the
	 * overlay holds the alternate screen). The frame paints from screen row 0,
	 * so report coordinates index directly into the last rendered lines: scene
	 * body rows start at #bodyRowStart, indented by SCENE_MARGIN_X. Scenes
	 * that implement routeMouse get hit-tested events (wheel, hover, click);
	 * for the rest a wheel notch falls back to an arrow key. A left click
	 * completes the outro like Enter. Raw reports never reach scene keyboard
	 * input.
	 */
	#routeMouseEvent(event: SgrMouseEvent): void {
		if (this.#phase === "outro") {
			if (event.leftClick) this.#complete();
			return;
		}
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
			case "outro":
				lines = renderSetupOutro(safeWidth, height);
				break;
			case "scene":
				lines = this.#renderScene(safeWidth, height);
				break;
			case "done":
				lines = [];
				break;
		}
		return this.#fitToScreen(lines, safeWidth, height);
	}

	#renderScene(width: number, height: number): string[] {
		const scene = this.scenes[this.#sceneIndex];
		const title = this.#activeScene?.title ?? scene?.title ?? "Setup";
		const subtitle = this.#activeScene?.subtitle;
		const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - SCENE_MARGIN_X * 2);
		const logo = gradientLogo(PI_LOGO, 0);
		const header = [
			"",
			...logo.map(line => centerLine(line, width)),
			centerLine(theme.bold(theme.fg("accent", BINARY_NAME)), width),
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

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			if (this.#disposed) return;
			if (this.#phase === "outro" && performance.now() - this.#phaseStartedAt >= SETUP_OUTRO_MS) {
				this.#complete();
				return;
			}
		}, OUTRO_TICK_MS);
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	#mountSceneController(targetPhase: "scene"): void {
		if (this.#disposed) return;
		this.#unmountActiveScene();
		if (this.#sceneIndex >= this.scenes.length) {
			this.#beginOutro();
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
		this.#phaseStartedAt = performance.now();
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

	#beginOutro(): void {
		if (this.#phase === "done") return;
		this.#unmountActiveScene();
		this.#phase = "outro";
		this.#phaseStartedAt = performance.now();
		this.ctx.ui.setFocus(this);
		this.#startTimer();
		this.ctx.ui.requestRender();
	}

	#complete(): void {
		if (this.#phase === "done") return;
		this.#phase = "done";
		this.#stopTimer();
		this.#done.resolve();
	}
}
