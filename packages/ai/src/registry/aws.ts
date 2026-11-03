import * as fs from "node:fs";
import { $env, $flag } from "@oh-my-pi/pi-utils";
import { awsSharedFilePaths, hasConfiguredAwsProfile } from "../utils/aws-profile";
import { AUTHENTICATED_SENTINEL } from "./types";

export interface AwsBedrockProviderOptions extends Readonly<Record<string, unknown>> {
	region?: string;

	profile?: string;

	bearerToken?: string;
}

let cachedEc2Host: boolean | undefined;

function isEc2Host(): boolean {
	if (cachedEc2Host !== undefined) return cachedEc2Host;
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
			if (matches(value)) {
				cachedEc2Host = true;
				return true;
			}
		} catch {}
	}
	cachedEc2Host = false;
	return false;
}

let awsProfileProbe: { key: string; value: boolean } | undefined;

function awsFileStamp(filePath: string): string {
	try {
		const stat = fs.statSync(filePath, { throwIfNoEntry: false });
		return stat ? `${stat.mtimeMs}:${stat.size}` : "-";
	} catch {
		return "-";
	}
}

function hasCachedAwsProfile(): boolean {
	const { credentialsPath, configPath } = awsSharedFilePaths();
	const key = [
		$env.AWS_PROFILE,
		$env.AWS_SDK_LOAD_CONFIG,
		!!($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY),
		!!($env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || $env.AWS_CONTAINER_CREDENTIALS_FULL_URI),
		$env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === "true",
		credentialsPath,
		awsFileStamp(credentialsPath),
		configPath,
		awsFileStamp(configPath),
	].join("\u0000");
	if (awsProfileProbe?.key === key) return awsProfileProbe.value;
	const value = hasConfiguredAwsProfile();
	awsProfileProbe = { key, value };
	return value;
}

export function hasAwsCredentialSource(): boolean {
	if ($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY) return true;
	if ($env.AWS_BEARER_TOKEN_BEDROCK) return true;
	if ($env.AWS_WEB_IDENTITY_TOKEN_FILE && $env.AWS_ROLE_ARN) return true;
	if ($env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || $env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return true;
	const hasInstanceRole =
		$env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true" &&
		(!!$env.AWS_EC2_METADATA_SERVICE_ENDPOINT || isEc2Host());
	return hasInstanceRole || hasCachedAwsProfile();
}

export function resolveAwsRegistryApiKey(options?: { allowSkipAuth?: boolean }): string | undefined {
	if (options?.allowSkipAuth && $flag("AWS_BEDROCK_SKIP_AUTH")) return AUTHENTICATED_SENTINEL;
	return hasAwsCredentialSource() ? AUTHENTICATED_SENTINEL : undefined;
}

export function resolveAwsBearerToken(apiKey?: string, bearerToken?: string): string | undefined {
	const resolvedApiKey = apiKey === AUTHENTICATED_SENTINEL ? undefined : apiKey;
	return bearerToken || resolvedApiKey || $env.AWS_BEARER_TOKEN_BEDROCK;
}
