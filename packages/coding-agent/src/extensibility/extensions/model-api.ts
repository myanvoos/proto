import type { Api, Model } from "@oh-my-pi/pi-ai";
import { modelFamilyToken } from "@oh-my-pi/pi-catalog/identity";
import type { ModelRegistry } from "../../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { ExtensionModelQuery } from "./types";

export function createExtensionModelQuery(
	modelRegistry: ModelRegistry,
	settings: Settings | undefined,
	getModel: () => Model | undefined,
): ExtensionModelQuery {
	return {
		list: () => modelRegistry.getAvailable(),
		current: () => getModel(),

		resolve: (spec: string): Model<Api> | undefined =>
			resolveModelRoleValue(spec, modelRegistry.getAvailable(), {
				settings,
				matchPreferences: getModelMatchPreferences(settings),
			}).model,
		family: (model: Model<Api>): string => modelFamilyToken(model.id) || model.provider.toLowerCase(),
	};
}
