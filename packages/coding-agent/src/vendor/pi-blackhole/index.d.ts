import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionFactory } from "../../extensibility/extensions/types";

export function resolveMemoryModelCandidates(context: {
	model?: Model;
	models: { resolve(spec: string): Model | undefined };
}): Model[];

declare const piBlackhole: ExtensionFactory;

export default piBlackhole;
