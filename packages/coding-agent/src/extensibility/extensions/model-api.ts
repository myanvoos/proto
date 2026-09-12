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
		roleCandidates: (roles: string[]): Model<Api>[] => {
			const available = modelRegistry.getAvailable();
			const matchPreferences = getModelMatchPreferences(settings);
			const current = getModel();
			const roleModels = roles
				.map(role => resolveModelRoleValue(`@${role}`, available, { settings, matchPreferences }).model)
				.filter((model): model is Model<Api> => model !== undefined);
			const currentHasRole =
				current !== undefined &&
				roleModels.some(model => model.provider === current.provider && model.id === current.id);
			const ordered = currentHasRole ? [current, ...roleModels] : [...roleModels, current];
			const seen = new Set<string>();
			return ordered.filter((model): model is Model<Api> => {
				if (!model) return false;
				const key = `${model.provider}/${model.id}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		},
		family: (model: Model<Api>): string => modelFamilyToken(model.id) || model.provider.toLowerCase(),
	};
}
