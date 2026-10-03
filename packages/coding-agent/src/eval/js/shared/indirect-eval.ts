export function indirectEval(source: string, filename?: string): unknown {
	// A line terminator in the filename would end the pragma comment and run the rest as source.
	const sourceUrl = filename?.replace(/[\r\n\u2028\u2029]/g, separator => encodeURIComponent(separator));
	const withPragma = sourceUrl ? `${source}\n//# sourceURL=${sourceUrl}` : source;

	const geval = globalThis.eval as (src: string) => unknown;
	return geval(withPragma);
}

export async function awaitMaybePromise<T>(value: T | Promise<T>): Promise<T> {
	if (!value || typeof value !== "object" || typeof (value as { then?: unknown }).then !== "function") {
		return value;
	}
	return await (value as Promise<T>);
}
