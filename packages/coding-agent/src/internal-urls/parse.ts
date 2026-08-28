import type { InternalUrl } from "./types";

const SCHEME_HOST_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;
const PATHNAME_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i;

const OPAQUE_URI_RE = /^([a-z][a-z0-9+.-]*):(.+)$/is;

const SELECTOR_CHUNK_SRC = String.raw`(?:raw|conflicts|-?\d+(?:[-+]\d+)?(?:,\d+(?:[-+]\d+)?)*)`;
const SELECTOR_CHAIN_RE = new RegExp(`^${SELECTOR_CHUNK_SRC}(?::${SELECTOR_CHUNK_SRC})*$`, "i");

export function extractUriScheme(input: string): string | undefined {
	const hierarchical = input.match(SCHEME_HOST_RE);
	if (hierarchical) return hierarchical[1].toLowerCase();
	const opaque = input.match(OPAQUE_URI_RE);
	if (!opaque) return undefined;
	const [, scheme, rest] = opaque;
	if (scheme.length === 1) return undefined;
	if (scheme.includes(".")) return undefined;
	if (SELECTOR_CHAIN_RE.test(rest)) return undefined;
	return scheme.toLowerCase();
}

export function parseInternalUrl(input: string): InternalUrl {
	const hostMatch = input.match(SCHEME_HOST_RE);
	const pathMatch = input.match(PATHNAME_RE);

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		if (!hostMatch) {
			throw new Error(`Invalid URL: ${input}`);
		}

		const hashIdx = input.indexOf("#");
		const hash = hashIdx !== -1 ? input.slice(hashIdx) : "";
		const withoutHash = hashIdx !== -1 ? input.slice(0, hashIdx) : input;
		const queryIdx = withoutHash.indexOf("?");
		const search = queryIdx !== -1 ? withoutHash.slice(queryIdx) : "";
		const queryString = search.slice(1);

		let rawPathname = pathMatch?.[1] ?? "";
		if (queryIdx !== -1 && rawPathname.includes("?")) {
			rawPathname = rawPathname.slice(0, rawPathname.indexOf("?"));
		}

		parsed = {
			protocol: `${hostMatch[1]}:`,
			hostname: hostMatch[2] ?? "",
			host: hostMatch[2] ?? "",
			pathname: rawPathname,
			href: input,
			search,
			hash,
			searchParams: new URLSearchParams(queryString),
		} as unknown as URL;
	}

	let rawHost = hostMatch ? hostMatch[2] : parsed.hostname;
	try {
		rawHost = decodeURIComponent(rawHost);
	} catch {}

	const result = parsed as InternalUrl;
	result.rawHost = rawHost;
	result.rawPathname = pathMatch?.[1] ?? parsed.pathname;
	result.rawHref = input;
	return result;
}
