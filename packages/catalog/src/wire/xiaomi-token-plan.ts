/** Both token-plan key prefixes must use a regional subscription endpoint. */
export function isXiaomiTokenPlanKey(apiKey: string): boolean {
	return apiKey.startsWith("tp-") || apiKey.startsWith("ttp-");
}
