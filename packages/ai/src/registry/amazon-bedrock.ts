import { type AwsBedrockProviderOptions, resolveAwsRegistryApiKey } from "./aws";
import type { ProviderDefinition } from "./types";

export const amazonBedrockProvider = {
	id: "amazon-bedrock",
	name: "Amazon Bedrock",

	envKeys: () => resolveAwsRegistryApiKey({ allowSkipAuth: true }),
	mapSimpleOptions: options => {
		const awsOptions = options.providerOptions as AwsBedrockProviderOptions | undefined;
		return {
			region: awsOptions?.region,
			profile: awsOptions?.profile,
			bearerToken: awsOptions?.bearerToken,
		};
	},
} as const satisfies ProviderDefinition;
