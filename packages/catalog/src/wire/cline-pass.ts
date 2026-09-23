export const CLINEPASS_API_BASE_URL = "https://api.cline.bot/api/v1";

// Mirrors the official Cline CLI request identity (sdk/packages/llms/src/providers/request-headers.ts).
// Cline's gateway gates some roster entries (certain free-tier models) to Cline product surfaces, so the
// full header set is sent on every api.cline.bot call; partial mirrors are one gateway change away from a 403.
export function clinePassClientHeaders(taskId?: string): Record<string, string> {
	return {
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": "cline-sdk",
		"User-Agent": "Cline/3.0.58",
		"X-CLIENT-VERSION": "3.0.58",
		"X-PLATFORM": process.platform,
		"X-PLATFORM-VERSION": "3.0.54",
		"X-CORE-VERSION": "0.0.79",
		...(taskId ? { "X-Task-ID": taskId } : {}),
	};
}
