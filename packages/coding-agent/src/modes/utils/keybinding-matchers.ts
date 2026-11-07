import { getKeybindings, type KeybindingsManager, type KeyId, matchesKey } from "@oh-my-pi/pi-tui";

export function matchesAppInterrupt(data: string): boolean {
	const keybindings = getKeybindings();
	const interruptKeys = keybindings.getKeys("app.interrupt");
	if (interruptKeys.length > 0) {
		return keybindings.matches(data, "app.interrupt");
	}
	return matchesKey(data, "escape") || matchesKey(data, "esc");
}

export function matchesAppToolsExpand(data: string): boolean {
	const keybindings = getKeybindings();
	const expandKeys = keybindings.getKeys("app.tools.expand");
	if (expandKeys.length > 0) {
		return keybindings.matches(data, "app.tools.expand");
	}
	return matchesKey(data, "ctrl+o");
}

export function matchesSelectCancel(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.cancel");
}

export function matchesSelectUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.up");
}

export function matchesSelectDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.down");
}

export function matchesSelectExtendUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.extendUp");
}

export function matchesSelectExtendDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.extendDown");
}

export function matchesSelectExtendPageUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.extendPageUp");
}

export function matchesSelectExtendPageDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.extendPageDown");
}

export function matchesSelectPageUp(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageUp");
}

export function matchesSelectPageDown(data: string): boolean {
	return getKeybindings().matches(data, "tui.select.pageDown");
}

export function matchesAppExternalEditor(data: string): boolean {
	const keybindings = getKeybindings();
	const externalEditorKeys = keybindings.getKeys("app.editor.external");
	if (externalEditorKeys.length > 0) {
		return keybindings.matches(data, "app.editor.external");
	}
	return matchesKey(data, "ctrl+g");
}

function matchesEffectiveKey(data: string, key: KeyId): boolean {
	if ((key === "ctrl+enter" || key === "ctrl+return") && data.charCodeAt(0) === 10 && data.length > 1) {
		return true;
	}
	return matchesKey(data, key);
}

function matchesEffectiveKeys(data: string, keys: readonly KeyId[]): boolean {
	for (const key of keys) {
		if (matchesEffectiveKey(data, key)) return true;
	}
	return false;
}

/** Keys follow-up falls back to when `app.message.followUp` is unbound: it must stay reachable by keyboard. */
const UNBOUND_FOLLOW_UP_KEYS: readonly KeyId[] = ["ctrl+enter", "ctrl+q"];

/** Effective follow-up keys: the `app.message.followUp` bindings, or Ctrl+Enter/Ctrl+Q when unbound. */
export function appFollowUpKeys(keybindings: KeybindingsManager = getKeybindings()): readonly KeyId[] {
	const keys = keybindings.getKeys("app.message.followUp");
	return keys.length > 0 ? keys : UNBOUND_FOLLOW_UP_KEYS;
}

export function matchesAppFollowUp(data: string): boolean {
	return matchesEffectiveKeys(data, appFollowUpKeys());
}
