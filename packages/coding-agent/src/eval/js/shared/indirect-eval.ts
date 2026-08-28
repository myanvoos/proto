export function indirectEval(source: string, filename?: string): unknown {
	const withPragma = filename ? `${source}\n//# sourceURL=${filename}` : source;

	const geval = globalThis.eval as (src: string) => unknown;
	return geval(withPragma);
}

export async function awaitMaybePromise<T>(value: T | Promise<T>): Promise<T> {
	if (!value || typeof value !== "object" || typeof (value as { then?: unknown }).then !== "function") {
		return value;
	}
	return await (value as Promise<T>);
}
