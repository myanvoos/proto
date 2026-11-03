import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { MCPProgress } from "./types";

export function withProgressToken(
	params: Record<string, unknown> | undefined,
	token: string | number,
): Record<string, unknown> {
	return { ...params, _meta: { ...(isRecord(params?._meta) ? params._meta : {}), progressToken: token } };
}

export function routeProgressNotification(
	method: string,
	params: unknown,
	callbackFor: (token: string | number) => ((progress: MCPProgress) => void) | undefined,
): void {
	if (method !== "notifications/progress" || !isRecord(params)) return;
	const token = params.progressToken;
	if (typeof token !== "string" && !(typeof token === "number" && Number.isFinite(token))) return;
	if (typeof params.progress !== "number" || !Number.isFinite(params.progress)) return;
	const callback = callbackFor(token);
	if (!callback) return;
	const progress: MCPProgress = { progress: params.progress };
	if (typeof params.total === "number" && Number.isFinite(params.total)) progress.total = params.total;
	if (typeof params.message === "string") progress.message = params.message;
	try {
		callback(progress);
	} catch (error) {
		logger.debug("MCP progress callback failed", { error });
	}
}
