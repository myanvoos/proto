import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolSession } from "../tools";

interface BridgeCwdScope {
	session: ToolSession;
	cwd: string;
}

const bridgeCwdScope = new AsyncLocalStorage<BridgeCwdScope>();

/**
 * Run a tool call that a kernel cell made through the eval bridge (`tool.read(...)`,
 * `publish_artifact(path=...)`, …) against that cell's working directory. Tools resolve relative
 * paths through `session.cwd`, whose getter consults {@link bridgeCwdFor}, so a relative path names
 * the same file for the bridged tool as for the cell's own `open()`. `cwd` must be a host path;
 * remote kernel targets pass none and keep resolving against the session directory.
 */
export function runWithBridgeCwd<T>(session: ToolSession, cwd: string | undefined, run: () => T): T {
	if (!cwd) return run();
	return bridgeCwdScope.run({ session, cwd }, run);
}

/** The calling cell's cwd while one of `session`'s bridged tool calls runs; other sessions are unaffected. */
export function bridgeCwdFor(session: ToolSession): string | undefined {
	const scope = bridgeCwdScope.getStore();
	return scope?.session === session ? scope.cwd : undefined;
}
