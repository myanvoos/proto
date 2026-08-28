import type { Api } from "./types";

declare const models: {
	[provider: string]: {
		[modelId: string]: { readonly api: Api; [key: string]: unknown };
	};
};
export default models;
