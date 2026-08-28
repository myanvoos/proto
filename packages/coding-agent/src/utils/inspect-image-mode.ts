import type { Model } from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";

export type InspectImageMode = "auto" | "on" | "off";

export const INSPECT_IMAGE_MODES = ["auto", "on", "off"] as const;

interface InspectImageModeContext {
	settings: Pick<Settings, "get">;
	getActiveModel?: () => Model | undefined;
	getInspectImageModeOverride?: () => InspectImageMode | undefined;
}

export function isInspectImageToolActive(session: InspectImageModeContext): boolean {
	const mode = session.getInspectImageModeOverride?.() ?? session.settings.get("inspect_image.mode");
	if (mode === "on") return true;
	if (mode === "off") return false;
	const model = session.getActiveModel?.();
	return !(model?.input?.includes("image") ?? false);
}
