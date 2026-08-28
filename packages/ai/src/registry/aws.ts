import * as fs from "node:fs";
import { $env, $flag } from "@oh-my-pi/pi-utils";
import { hasConfiguredAwsProfile } from "../utils/aws-profile";
import { AUTHENTICATED_SENTINEL } from "./types";

export interface AwsBedrockProviderOptions extends Readonly<Record<string, unknown>> {
	region?: string;

	profile?: string;

	bearerToken?: string;
}

function isEc2Host(): boolean {
	const checks: Array<[path: string, matches: (value: string) => boolean]> = [
		["/sys/hypervisor/uuid", v => v.startsWith("ec2")],
		["/sys/devices/virtual/dmi/id/product_uuid", v => v.startsWith("ec2")],
		["/sys/devices/virtual/dmi/id/board_asset_tag", v => v.startsWith("ec2") || v.startsWith("i-")],
		["/sys/devices/virtual/dmi/id/sys_vendor", v => v.includes("amazon ec2")],
		["/sys/devices/virtual/dmi/id/bios_vendor", v => v.includes("amazon ec2")],
	];
	for (const [candidate, matches] of checks) {
		try {
			const value = fs.readFileSync(candidate, "utf8").trim().toLowerCase();
			if (matches(value)) return true;
		} catch {}
	}
	return false;
}

export function hasAwsCredentialSource(): boolean {
	const hasEcsCredentials = !!$env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!$env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	const hasWebIdentity = !!$env.AWS_WEB_IDENTITY_TOKEN_FILE && !!$env.AWS_ROLE_ARN;
	const hasProfile = hasConfiguredAwsProfile();
	const hasInstanceRole =
		$env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true" &&
		(!!$env.AWS_EC2_METADATA_SERVICE_ENDPOINT || isEc2Host());
	return !!(
		($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) ||
		$env.AWS_BEARER_TOKEN_BEDROCK ||
		hasWebIdentity ||
		hasProfile ||
		hasEcsCredentials ||
		hasInstanceRole
	);
}

export function resolveAwsRegistryApiKey(options?: { allowSkipAuth?: boolean }): string | undefined {
	if (options?.allowSkipAuth && $flag("AWS_BEDROCK_SKIP_AUTH")) return AUTHENTICATED_SENTINEL;
	return hasAwsCredentialSource() ? AUTHENTICATED_SENTINEL : undefined;
}

export function resolveAwsBearerToken(apiKey?: string, bearerToken?: string): string | undefined {
	const resolvedApiKey = apiKey === AUTHENTICATED_SENTINEL ? undefined : apiKey;
	return bearerToken || resolvedApiKey || $env.AWS_BEARER_TOKEN_BEDROCK;
}
