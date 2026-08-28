import { getKeybindings, type Keybinding } from "@oh-my-pi/pi-tui";
import { type AppKeybinding, formatKeyHints, type KeybindingsManager } from "../../config/keybindings";
import { theme } from "../../modes/theme/theme";

export function editorKey(action: Keybinding): string {
	return formatKeyHints(getKeybindings().getKeys(action));
}

export function appKey(keybindings: KeybindingsManager, action: AppKeybinding): string {
	return formatKeyHints(keybindings.getKeys(action));
}

export function keyHint(action: Keybinding, description: string): string {
	return theme.fg("dim", editorKey(action)) + theme.fg("muted", ` ${description}`);
}

export function appKeyHint(keybindings: KeybindingsManager, action: AppKeybinding, description: string): string {
	return theme.fg("dim", appKey(keybindings, action)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}
