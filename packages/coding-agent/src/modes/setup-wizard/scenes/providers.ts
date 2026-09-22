import { type SgrMouseEvent, TabBar, truncateToWidth } from "@oh-my-pi/pi-tui";
import { getTabBarTheme } from "../../shared";
import { theme } from "../../theme/theme";
import { SignInTab } from "./sign-in";
import type { SetupScene, SetupSceneController, SetupSceneHost, SetupTab } from "./types";
import { WebSearchTab } from "./web-search";

class ProvidersSceneController implements SetupSceneController {
	title = "Set up your providers";
	subtitle = "Sign in and pick a web search provider. Esc skips this step.";

	#tabs: SetupTab[];
	#tabBar: TabBar;

	#tabRowCount = 1;
	#bodyRowStart = 2;
	#compactTabs = false;

	constructor(host: SetupSceneHost) {
		this.#tabs = [new SignInTab(host), new WebSearchTab(host)];
		this.#tabBar = new TabBar(
			"Providers",
			this.#tabs.map(tab => ({ id: tab.id, label: tab.label })),
			getTabBarTheme(),
		);
		this.#tabBar.onTabChange = () => {
			this.#activeTab().onActivate?.();
			host.requestRender();
		};
	}

	#activeTab(): SetupTab {
		return this.#tabs[this.#tabBar.getActiveIndex()] ?? this.#tabs[0];
	}

	onMount(): void {
		this.#activeTab().onActivate?.();
	}

	invalidate(): void {
		for (const tab of this.#tabs) tab.invalidate();
	}

	handleInput(data: string): void {
		const tab = this.#activeTab();
		if (tab.modal) {
			tab.handleInput(data);
			return;
		}
		if (this.#tabBar.handleInput(data)) return;
		tab.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const tab = this.#activeTab();
		if (event.wheel === null && line >= 0 && line < this.#tabRowCount) {
			if (tab.modal) return;
			if (this.#compactTabs) {
				if (event.leftClick && col >= 0) this.#tabBar.nextTab();
				return;
			}
			const hit = this.#tabBar.tabAt(line, col);
			if (event.motion) {
				this.#tabBar.setHoverTab(hit && !hit.muted ? hit.id : null);
			} else if (event.leftClick && hit) {
				this.#tabBar.selectTab(hit.id);
			}
			return;
		}
		if (event.motion) this.#tabBar.setHoverTab(null);
		const bodyLine = line - this.#bodyRowStart;
		if (tab.routeMouse) {
			tab.routeMouse(event, bodyLine, col);
			return;
		}
		if (event.wheel !== null && !tab.modal) {
			tab.handleInput(event.wheel === -1 ? "\x1b[A" : "\x1b[B");
		}
	}

	render(width: number, maxLines?: number): readonly string[] {
		let tabLines = [...this.#tabBar.render(width)];
		this.#compactTabs = maxLines !== undefined && tabLines.length + 4 > maxLines;
		if (this.#compactTabs) {
			tabLines =
				maxLines! >= 4 ? [truncateToWidth(theme.fg("accent", `${this.#activeTab().label} ↔ Tab`), width)] : [];
		}
		this.#tabRowCount = tabLines.length;
		const header = this.#compactTabs ? tabLines : [...tabLines, ""];
		this.#bodyRowStart = header.length;
		const tabBudget = maxLines === undefined ? undefined : Math.max(0, maxLines - header.length);
		return [...header, ...this.#activeTab().render(width, tabBudget)];
	}

	dispose(): void {
		for (const tab of this.#tabs) tab.dispose();
	}
}

export const providersSetupScene: SetupScene = {
	id: "providers",
	title: "Set up your providers",
	minVersion: 1,
	mount: host => new ProvidersSceneController(host),
};
