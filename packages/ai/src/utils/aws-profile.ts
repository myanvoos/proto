import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";

export type AwsIniFile = Record<string, Record<string, string>>;

export function parseAwsIni(text: string): AwsIniFile {
	const out: AwsIniFile = {};
	let current: Record<string, string> | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			let name = line.slice(1, -1).trim();
			if (name.startsWith("profile ")) name = name.slice(8).trim();
			if (name.startsWith("sso-session ")) name = `sso-session:${name.slice(12).trim()}`;
			let section = out[name];
			if (!section) {
				section = {};
				out[name] = section;
			}
			current = section;
			continue;
		}
		if (!current) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

function readAwsIniSync(filePath: string): AwsIniFile | undefined {
	try {
		return parseAwsIni(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

export function resolveAwsProfile(profile?: string): string {
	return profile || $env.AWS_PROFILE || "default";
}

export function shouldLoadAwsSharedConfig(profile?: string): boolean {
	if (profile || $env.AWS_PROFILE) return true;
	const value = $env.AWS_SDK_LOAD_CONFIG?.toLowerCase();
	return value === "1" || value === "true";
}

export function resolveAwsProfileRegion(profile?: string): string | undefined {
	if (!shouldLoadAwsSharedConfig(profile)) return undefined;
	const configPath = $env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");
	return readAwsIniSync(configPath)?.[resolveAwsProfile(profile)]?.region;
}

export function resolveAwsAmbientRegion(profile?: string): string | undefined {
	return $env.AWS_REGION || $env.AWS_DEFAULT_REGION || resolveAwsProfileRegion(profile);
}

export function resolveAwsRegion(explicitRegion?: string, profile?: string): string {
	return explicitRegion || resolveAwsAmbientRegion(profile) || "us-east-1";
}

export function hasConfiguredAwsProfile(profile?: string): boolean {
	const selectedProfile = resolveAwsProfile(profile);
	const credentialsPath = $env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), ".aws", "credentials");
	const configPath = $env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");
	const credentialsIni = readAwsIniSync(credentialsPath);
	const configIni = shouldLoadAwsSharedConfig(profile) ? readAwsIniSync(configPath) : undefined;
	return profileHasCredentialSource(selectedProfile, credentialsIni, configIni, new Set());
}

function profileHasCredentialSource(
	profile: string,
	credentialsIni: AwsIniFile | undefined,
	configIni: AwsIniFile | undefined,
	seen: Set<string>,
): boolean {
	if (seen.has(profile)) return false;
	seen.add(profile);
	const merged = { ...(configIni?.[profile] ?? {}), ...(credentialsIni?.[profile] ?? {}) };
	if (merged.role_arn) {
		if (merged.web_identity_token_file) return true;
		if (merged.mfa_serial) return false;
		if (merged.credential_source) {
			switch (merged.credential_source) {
				case "Environment":
					return !!($env.AWS_ACCESS_KEY_ID && $env.AWS_SECRET_ACCESS_KEY);
				case "EcsContainer":
					return !!($env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || $env.AWS_CONTAINER_CREDENTIALS_FULL_URI);
				case "Ec2InstanceMetadata":
					return $env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true";
				default:
					return false;
			}
		}
		if (merged.source_profile)
			return profileHasCredentialSource(merged.source_profile, credentialsIni, configIni, seen);
		return false;
	}
	if (merged.aws_access_key_id && merged.aws_secret_access_key) return true;
	if (merged.credential_process) return true;
	if (!merged.sso_account_id || !merged.sso_role_name) return false;
	if (merged.sso_start_url && merged.sso_region) return true;
	const session = merged.sso_session ? configIni?.[`sso-session:${merged.sso_session}`] : undefined;
	return !!(session?.sso_start_url && session.sso_region);
}
