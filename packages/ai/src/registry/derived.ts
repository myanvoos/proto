import { PROVIDER_REGISTRY } from "./registry";

export const PASTE_CODE_LOGIN_PROVIDERS: ReadonlySet<string> = new Set(
	PROVIDER_REGISTRY.filter(p => p.pasteCodeFlow).map(p => p.id),
);
