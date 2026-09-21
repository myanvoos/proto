import { Box, Container, Spacer, Text } from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import type { ChecklistItem } from "../../tools/checklist";

export class ChecklistReminderComponent extends Container {
	#box: Box;
	#toolActivityVisible = true;

	constructor(
		private readonly items: ChecklistItem[],
		private readonly attempt: number,
		private readonly maxAttempts: number,
	) {
		super();

		this.addChild(new Spacer(1));

		this.#box = new Box(1, 1, t => theme.inverse(theme.fg("warning", t)));
		this.#box.setIgnoreTight(true);
		this.addChild(this.#box);

		this.#rebuild();
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		if (!this.#toolActivityVisible) return [];
		return super.render(width);
	}

	#rebuild(): void {
		this.#box.clear();

		const count = this.items.length;
		const label = count === 1 ? "checklist" : "checklist items";
		const header = `${theme.icon.warning} ${count} incomplete ${label} - reminder ${this.attempt}/${this.maxAttempts}`;

		this.#box.addChild(new Text(header, 0, 0));
		this.#box.addChild(new Spacer(1));

		const checklistList = this.items
			.map(checklist => `  ${theme.checkbox.unchecked} ${checklist.content}`)
			.join("\n");
		this.#box.addChild(new Text(theme.italic(checklistList), 0, 0));
	}
}
