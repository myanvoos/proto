import type { Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";

export type InspectMediaMode = "auto" | "on" | "off";

export const INSPECT_MEDIA_MODES = ["auto", "on", "off"] as const;

interface InspectMediaModeContext {
	settings: Pick<Settings, "get">;
	getActiveModel?: () => Model | undefined;
	getInspectMediaModeOverride?: () => InspectMediaMode | undefined;
}

export function isInspectMediaToolActive(session: InspectMediaModeContext): boolean {
	const mode = session.getInspectMediaModeOverride?.() ?? session.settings.get("inspect_media.mode");
	if (mode === "on") return true;
	if (mode === "off") return false;
	const model = session.getActiveModel?.();
	return !(model?.input?.includes("image") ?? false);
}
