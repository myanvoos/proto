import type { ToolSession } from ".";
import { noteFileWritten } from "./fs-mutation";
import { isInternalUrlPath, targetsLocalSandbox } from "./path-utils";
import { ToolError } from "./tool-errors";

function shouldRouteWriteThroughBridge(session: ToolSession, requestedPath: string, absolutePath: string): boolean {
	if (isInternalUrlPath(requestedPath)) return false;

	if (targetsLocalSandbox(session, absolutePath)) return false;

	return true;
}

interface BridgeWriteResult {
	text: string;

	driftedFromRequest: boolean;
}

export async function routeWriteThroughBridge(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<BridgeWriteResult | undefined> {
	if (!shouldRouteWriteThroughBridge(session, requestedPath, absolutePath)) return undefined;

	const bridge = session.getClientBridge?.();
	if (!bridge?.capabilities.writeTextFile || !bridge.writeTextFile) return undefined;

	signal?.throwIfAborted();
	try {
		await bridge.writeTextFile({ path: absolutePath, content });
	} catch (error) {
		throw new ToolError(error instanceof Error ? error.message : String(error));
	}
	await noteFileWritten(session, absolutePath);
	session.bumpFileMutationVersion?.(absolutePath);

	let actualText = content;
	try {
		actualText = await Bun.file(absolutePath).text();
	} catch {}
	return { text: actualText, driftedFromRequest: actualText !== content };
}
