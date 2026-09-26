import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, WriteContext } from "./types";

export const PROTOLENS_URL_PREFIX = "protolens://";

export function parseProtolensUrl(input: string): { name: string | null } | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(PROTOLENS_URL_PREFIX)) return null;
	const name = trimmed.slice(PROTOLENS_URL_PREFIX.length);
	if (name.length === 0) return { name: null };
	if (/[/?#]/.test(name)) return null;
	return { name };
}

export class ProtolensProtocolHandler implements ProtocolHandler {
	readonly scheme = "protolens";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const target = parseProtolensUrl(url.href);
		if (!target) throw new Error(`Invalid protolens:// URL: ${url.href}. Use protolens:// or protolens://<tool>.`);
		if (!context?.protolens) throw new Error("protolens:// is not mounted in this session.");
		const content = await context.protolens.read(target.name);
		return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<void> {
		const target = parseProtolensUrl(url.href);
		if (!target) throw new Error(`Invalid protolens:// URL: ${url.href}. Use protolens://<tool>.`);
		if (!context?.protolens) throw new Error("protolens:// is not mounted in this session.");
		await context.protolens.write(target.name, content);
	}
}
