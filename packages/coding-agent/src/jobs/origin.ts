import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionOrigin {
	lane: string;
	kind?: "shell" | "kernel";
	language?: "python" | "node" | "bun";
}

const origins = new AsyncLocalStorage<ExecutionOrigin>();

export function withExecutionOrigin<T>(origin: ExecutionOrigin, run: () => T): T {
	return origins.run(origin, run);
}

export function currentExecutionOrigin(): ExecutionOrigin | undefined {
	return origins.getStore();
}
