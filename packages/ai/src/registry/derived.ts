import { getProviderRegistry } from "./registry";

let pasteCodeLoginProviders: ReadonlySet<string> | undefined;

export function isPasteCodeLoginProvider(id: string): boolean {
	pasteCodeLoginProviders ??= new Set(
		getProviderRegistry()
			.filter(p => p.pasteCodeFlow)
			.map(p => p.id),
	);
	return pasteCodeLoginProviders.has(id);
}
