import { logger } from "@oh-my-pi/pi-utils";
import { clearAnthropicFastModeFallback } from "../providers/anthropic";
import { resetOpenAIResponsesAccountScopedState } from "../providers/openai-responses";
import type { Api, Context, Model, ProviderSessionState } from "../types";

/**
 * Per-conversation provider learning (sticky strict-tools / fast-mode / thinking
 * fallbacks, Codex transport sessions) owned by the gateway server. The map is
 * non-serializable, so gateway clients cannot bring their own; without a
 * server-side owner every turn re-learns each lesson from a fresh upstream
 * rejection. Entries own sockets and timers, so the store is bounded and closes
 * what it drops — but never an entry a request is still holding.
 */
export const AUTH_GATEWAY_MAX_SESSION_STATES = 256;

type SessionDisposeReason = "evict" | "shutdown";

export interface AuthGatewaySessionStateLease {
	readonly states: Map<string, ProviderSessionState>;
	/** Resets account-scoped records when an in-request auth retry switched accounts. */
	updateAccount(account: string): void;
	/** Makes the entry evictable again. Idempotent; MUST run on every request outcome. */
	release(): void;
}

export interface AuthGatewaySessionStateRequest {
	/** Client-supplied session key (`prompt_cache_key` / `sessionId`); blank counts as absent. */
	clientKey: string | undefined;
	model: Model<Api>;
	/** Used only without a client key, to place the request on the conversation it continues. */
	context: Context;
	/** Stable identity of the account the request's credential resolved to. */
	account: string;
}

interface RetainedSession {
	key: string;
	states: Map<string, ProviderSessionState>;
	account: string;
	leases: number;
}

/**
 * Resets what a provider learned about the *account* while keeping what it
 * learned about the endpoint: Anthropic's fast-mode entitlement and the OpenAI
 * Responses `previous_response_id` chain. Codex already sub-keys its transport
 * by account and bearer; GitLab Duo's live workflow stays on its own close path.
 */
function resetAccountScopedProviderSessionState(states: Map<string, ProviderSessionState>): void {
	if (states.size === 0) return;
	clearAnthropicFastModeFallback(states);
	resetOpenAIResponsesAccountScopedState(states);
}

function closeSessionState(
	states: Map<string, ProviderSessionState>,
	sessionKey: string,
	reason: SessionDisposeReason,
): void {
	for (const [providerKey, state] of states) {
		try {
			state.close();
		} catch (error) {
			// One provider's teardown must not abort the rest of the drain or the
			// request that triggered the eviction.
			logger.warn("auth-gateway provider session state close failed", {
				sessionKey,
				providerKey,
				reason,
				error: String(error),
			});
		}
	}
	states.clear();
}

/**
 * Index keys a request may be placed on, most specific first.
 *
 * A client key names the conversation outright. Without one, the derived
 * session id (model + system + tools + first message) is too coarse: two chats
 * that open alike would share one retained map and one chat's rejection would
 * silence the other. So retained state is keyed by a running hash over the
 * history instead — one key per message — and a turn claims the entry of its
 * nearest ancestor. Conversations separate as soon as they diverge.
 */
function sessionKeys(request: AuthGatewaySessionStateRequest): string[] {
	const { model } = request;
	const scope = `${model.provider}\u0000${model.id}`;
	if (request.clientKey !== undefined) return [`c\u0000${scope}\u0000${request.clientKey}`];
	const { context } = request;
	let hash = Bun.hash(
		`${scope}\u0000${context.systemPrompt?.join("\n\n") ?? ""}\u0000${context.tools ? JSON.stringify(context.tools) : ""}`,
	);
	const keys: string[] = [];
	for (const message of context.messages) {
		// Role + content only: parsed messages are re-stamped with fresh timestamps
		// every request, which would break the chain on turn two.
		hash = Bun.hash(JSON.stringify({ role: message.role, content: message.content }), hash);
		keys.push(`h\u0000${scope}\u0000${hash.toString(36)}`);
	}
	if (keys.length === 0) return [`h\u0000${scope}\u0000${hash.toString(36)}`];
	keys.reverse();
	return keys;
}

/**
 * Bounded provider-session state owned by one gateway server instance. Keyed by
 * provider + model + conversation; the credential is deliberately not in the
 * key — an account switch resets only the account-scoped records.
 *
 * Recency is the Map's insertion order (every claim re-inserts). `LRUCache`
 * cannot express the policy: leased entries must be skipped when evicting, and
 * an entry must be able to change key without being closed.
 */
export class AuthGatewaySessionStateStore {
	readonly #sessions = new Map<string, RetainedSession>();
	readonly #max: number;

	constructor(max: number = AUTH_GATEWAY_MAX_SESSION_STATES) {
		if (!Number.isInteger(max) || max < 1) throw new TypeError("max must be a positive integer");
		this.#max = max;
	}

	get size(): number {
		return this.#sessions.size;
	}

	acquire(request: AuthGatewaySessionStateRequest): AuthGatewaySessionStateLease {
		const session = this.#claim(sessionKeys(request), request.account);
		let released = false;
		return {
			states: session.states,
			updateAccount: (account: string): void => {
				if (session.account === account) return;
				resetAccountScopedProviderSessionState(session.states);
				session.account = account;
			},
			release: (): void => {
				if (released) return;
				released = true;
				session.leases--;
				if (session.leases === 0) this.#evict();
			},
		};
	}

	/** Closes every retained state, leased or not. Called once the listener is down. */
	close(): void {
		for (const session of this.#sessions.values()) closeSessionState(session.states, session.key, "shutdown");
		this.#sessions.clear();
	}

	#claim(keys: readonly string[], account: string): RetainedSession {
		const key = keys[0] ?? "";
		for (const candidate of keys) {
			const session = this.#sessions.get(candidate);
			if (session === undefined) continue;
			// Move the ancestor onto this request's own key so the next turn finds
			// it; a sibling branch of the same ancestor then starts clean.
			this.#sessions.delete(candidate);
			session.key = key;
			this.#sessions.set(key, session);
			session.leases++;
			if (session.account !== account) {
				resetAccountScopedProviderSessionState(session.states);
				session.account = account;
			}
			return session;
		}
		const created: RetainedSession = { key, states: new Map(), account, leases: 1 };
		this.#sessions.set(key, created);
		this.#evict();
		return created;
	}

	/**
	 * Enforces the ceiling against unleased entries only: a long-running stream
	 * is exactly what LRU order would pick, and closing it would tear down state
	 * that stream still uses. The overshoot is bounded by concurrent requests.
	 */
	#evict(): void {
		if (this.#sessions.size <= this.#max) return;
		for (const session of this.#sessions.values()) {
			if (this.#sessions.size <= this.#max) return;
			if (session.leases > 0) continue;
			this.#sessions.delete(session.key);
			closeSessionState(session.states, session.key, "evict");
		}
	}
}
