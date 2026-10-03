import { type CredentialDisabledEvent, getOAuthProviders } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/**
 * Warning for a credential the auth layer signed out on its own, or `undefined` when the provider has no `/login`
 * entry (MCP OAuth servers re-authorize through their own flow). The provider's failure text stays out: it is
 * provider-controlled and already recorded in the log and the stored disable cause.
 */
export function formatCredentialDisabledNotice(event: CredentialDisabledEvent): string | undefined {
	const providers = getOAuthProviders();
	const login =
		providers.find(provider => provider.id === event.provider) ??
		providers.find(provider => provider.storeCredentialsAs === event.provider);
	if (!login) return undefined;
	const account = sanitizeText(event.email ?? event.accountId ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const subject = account ? `${login.name} account ${account}` : `A ${login.name} account`;
	return `${subject} was signed out automatically. Run /login to sign in again.`;
}
