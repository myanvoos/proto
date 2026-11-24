import type { Component, SgrMouseEvent } from "@oh-my-pi/pi-tui";
import type { InteractiveModeContext } from "../../types";

export type SetupSceneResult = "done" | "skipped";

/**
 * What the wizard and its scenes read from their host. Interactive mode provides it, and so does the
 * bare terminal UI that ACP terminal auth runs the sign-in step in.
 */
export type SetupWizardContext = Pick<
	InteractiveModeContext,
	"ui" | "settings" | "session" | "openInBrowser" | "refreshScopedModelsAfterLogin"
>;

export interface SetupSceneHost {
	ctx: SetupWizardContext;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	onMount?(): void | Promise<void>;
	onUnmount?(): void;
	dispose?(): void;

	render(width: number, maxLines?: number): readonly string[];

	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
}

export interface SetupTab {
	readonly id: string;
	readonly label: string;

	readonly modal: boolean;

	render(width: number, maxLines?: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;

	onActivate?(): void;

	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	dispose(): void;
}

export interface SetupScene {
	id: string;
	title: string;
	minVersion: number;
	shouldRun?(ctx: SetupWizardContext): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}
