import type { Model } from "@oh-my-pi/pi-ai";

type ComputerExposureMode = "function" | "unavailable";

export function computerExposureMode(model: Model | undefined): ComputerExposureMode {
	return model ? "function" : "unavailable";
}
