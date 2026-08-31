import { TERMINAL } from "@oh-my-pi/pi-tui";
import { Settings } from "../../config/settings";
import {
	type AnyUiMetadata,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
} from "../../config/settings-schema";

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;

	warning?: string;
	tab: SettingTab;

	group?: string;

	condition?: () => boolean;
}

interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: OptionList;
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| TextInputSettingDef
	| ProviderLimitsSettingDef
	| MultiSelectSettingDef;

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => {
		try {
			return Settings.instance.get("advisor.enabled") === true;
		} catch {
			return false;
		}
	},
	conductorEnabled: () => {
		try {
			return Settings.instance.get("conductor.enabled") === true;
		} catch {
			return false;
		}
	},
	autolearnActive: () => {
		try {
			return Settings.instance.get("autolearn.enabled") === true;
		} catch {
			return false;
		}
	},
	usageAwareFallbackEnabled: () => {
		try {
			return Settings.instance.get("retry.usageAwareFallback") === true;
		} catch {
			return false;
		}
	},
};

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	if (!ui) return null;

	const schemaType = getType(path);
	const condition = ui.condition ? CONDITIONS[ui.condition] : undefined;
	const base = {
		path,
		label: ui.label,
		description: ui.description,
		warning: ui.warning,
		tab: ui.tab,
		group: ui.group,
		condition,
	};

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui);

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		}

		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		if (!options || options === "runtime") return null;
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "string") {
		if (options === "runtime") {
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}

		return { ...base, type: "text", secret: isCredential(path) };
	}

	if (schemaType === "array") {
		if (!options || options === "runtime") return null;
		return { ...base, type: "multiselect", options, ordered: ui.ordered === true };
	}

	if (schemaType === "record") {
		return path === "providers.maxInFlightRequests"
			? { ...base, type: "providerLimits" }
			: { ...base, type: "text", secret: false };
	}

	return null;
}

let cachedDefs: SettingDef[] | null = null;

function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
	cachedDefs = defs;
	return defs;
}

export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs().filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}
