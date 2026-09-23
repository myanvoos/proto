import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Api, Model } from "../types";

/**
 * Materialize `model.resolveHeaders` (config-backed credentials) into a clone with plain `headers` and no hook, for code
 * that sends a request itself instead of going through `stream`. Returns `model` unchanged when there is no hook.
 */
export async function materializeModelHeaders<TApi extends Api>(
	model: Model<TApi>,
	signal?: AbortSignal,
): Promise<Model<TApi>> {
	const resolveHeaders = model.resolveHeaders;
	if (!resolveHeaders) return model;
	const headers = await untilAborted(signal, () => resolveHeaders(signal));
	signal?.throwIfAborted();
	return { ...model, resolveHeaders: undefined, headers: headers ? { ...headers } : undefined };
}
