import { describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list";

const boxSymbols = {
	topLeft: "+",
	topRight: "+",
	bottomLeft: "+",
	bottomRight: "+",
	horizontal: "-",
	vertical: "|",
	teeDown: "+",
	teeUp: "+",
	teeLeft: "+",
	teeRight: "+",
	cross: "+",
};

const theme: SelectListTheme = {
	selectedPrefix: text => `<prefix>${text}</prefix>`,
	selectedText: text => `<selected>${text}</selected>`,
	description: text => `<description>${text}</description>`,
	scrollInfo: text => `<scroll>${text}</scroll>`,
	noMatch: text => `<empty>${text}</empty>`,
	icon: text => `<icon>${text}</icon>`,
	hovered: text => `<hover>${text}</hover>`,
	symbols: {
		cursor: ">",
		inputCursor: "|",
		boxRound: boxSymbols,
		boxSharp: boxSymbols,
		table: boxSymbols,
		quoteBorder: ">",
		hrChar: "-",
		spinnerFrames: ["-"],
	},
};

function makeItems(count: number): SelectItem[] {
	return Array.from({ length: count }, (_, index) => ({
		value: `value-${index}`,
		label: `Item\t${index}\nwith label`,
		description: `Description ${index} with enough words to wrap across multiple visual rows`,
		icon: index % 2 === 0 ? "◆" : undefined,
		hint: `hint-${index}`,
	}));
}

describe("SelectList layout caching", () => {
	it("does not re-layout offscreen items for a cursor-only repaint", () => {
		const items = makeItems(100);
		const visited = new Set<string>();
		const list = new SelectList(items, 6, theme, {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 24,
			wrapDescription: true,
			maxDescriptionRows: 3,
			truncatePrimary: context => {
				visited.add(context.item.value);
				return context.text;
			},
		});

		list.render(72);
		visited.clear();
		list.setSelectedIndex(1);
		list.render(72);

		expect(visited.has(items.at(-1)!.value)).toBe(false);
		expect(visited.size).toBeLessThan(10);
	});

	it("keeps cached cursor, hover, width, filter, and layout renders byte-identical to cold renders", () => {
		const items = makeItems(80);
		const layout: SelectListLayoutOptions = {
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 28,
			wrapDescription: true,
			maxDescriptionRows: 3,
		};
		const cached = new SelectList(items, 7, theme, layout);
		cached.render(76);

		cached.setSelectedIndex(37);
		const cachedCursor = cached.render(76);
		const coldCursor = new SelectList(items, 7, theme, { ...layout });
		coldCursor.setSelectedIndex(37);
		expect(cachedCursor).toEqual(coldCursor.render(76));

		cached.setHoverIndex(36);
		const coldHover = new SelectList(items, 7, theme, { ...layout });
		coldHover.setSelectedIndex(37);
		coldHover.setHoverIndex(36);
		expect(cached.render(76)).toEqual(coldHover.render(76));

		const coldWidth = new SelectList(items, 7, theme, { ...layout });
		coldWidth.setSelectedIndex(37);
		coldWidth.setHoverIndex(36);
		expect(cached.render(61)).toEqual(coldWidth.render(61));

		cached.setFilter("Item 4");
		const coldFilter = new SelectList(items, 7, theme, { ...layout });
		coldFilter.setFilter("Item 4");
		expect(cached.render(61)).toEqual(coldFilter.render(61));

		layout.maxDescriptionRows = 1;
		const coldLayout = new SelectList(items, 7, theme, { ...layout });
		coldLayout.setFilter("Item 4");
		expect(cached.render(61)).toEqual(coldLayout.render(61));
	});
});
