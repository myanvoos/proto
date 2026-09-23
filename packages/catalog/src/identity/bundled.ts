import { getBundledModels, getBundledProviders } from "../models";
import { isBareIdReferenceProvider } from "../provider-models/bundled-references";
import type { Api, Model } from "../types";
import { buildModelReferenceIndex, type ModelReferenceIndex } from "./reference";

let bundledModels: readonly Model<Api>[] | undefined;

function getBundledModelList(): readonly Model<Api>[] {
	// Gateway-namespaced providers must not seed canonical bare-id enrichment of unrelated proxies.
	bundledModels ??= getBundledProviders()
		.filter(isBareIdReferenceProvider)
		.flatMap(provider => getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[]);
	return bundledModels;
}

let referenceIndex: ModelReferenceIndex | undefined;

export function getBundledModelReferenceIndex(): ModelReferenceIndex {
	referenceIndex ??= buildModelReferenceIndex(getBundledModelList());
	return referenceIndex;
}
