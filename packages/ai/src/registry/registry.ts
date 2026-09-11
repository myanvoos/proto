import type { KnownProvider } from "@oh-my-pi/pi-catalog";
import { loadProviderDefinition, REGISTRY_IDS, type RegistryDefinition } from "./registry-lazy";
import type { ProviderDefinition } from "./types";

export type RegistryDef = RegistryDefinition;

let allProviders: readonly ProviderDefinition[] | undefined;
let byId: Map<string, ProviderDefinition> | undefined;

export function getProviderRegistry(): readonly ProviderDefinition[] {
	if (allProviders === undefined) {
		const all = REGISTRY_IDS.map(id => {
			const definition = loadProviderDefinition(id);
			if (!definition) throw new Error(`Provider definition missing from registry: ${id}`);
			return definition;
		});
		allProviders = all;
		byId = new Map(all.map(p => [p.id, p] as const));
	}
	return allProviders;
}

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	if (byId !== undefined) return byId.get(id);
	return loadProviderDefinition(id);
}

type _MissingCatalogProviders = Exclude<KnownProvider, RegistryDef["id"]>;
type _CheckRegistryComplete = _MissingCatalogProviders extends never
	? true
	: ["registry is missing catalog providers", _MissingCatalogProviders];
true satisfies _CheckRegistryComplete;

export type OAuthProviderUnion = Extract<RegistryDef, { login: object }>["id"];
