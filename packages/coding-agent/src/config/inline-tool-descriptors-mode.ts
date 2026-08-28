import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";

export function shouldInlineToolDescriptors(
	setting: "auto" | "on" | "off" | undefined,
	modelId: string | undefined,
): boolean {
	switch (setting ?? "auto") {
		case "on":
			return true;
		case "off":
			return false;
		default:
			return modelId !== undefined && modelFamilyToken(modelId) === "gemini";
	}
}
