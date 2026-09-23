import { describe, expect, it } from "bun:test";
import { createMockModel } from "../providers/mock";
import type { Context, ProviderSessionState } from "../types";
import { type AuthGatewaySessionStateRequest, AuthGatewaySessionStateStore } from "./session-state";

const model = createMockModel({ id: "session-model", provider: "session-provider" });

function keyless(context: Context, account = "key:a"): AuthGatewaySessionStateRequest {
	return { clientKey: undefined, model, context, account };
}

function turn(...texts: string[]): Context {
	return {
		systemPrompt: ["Stay concise."],
		messages: texts.map((text, index) =>
			index % 2 === 0
				? { role: "user", content: text, timestamp: index }
				: {
						role: "assistant",
						content: [{ type: "text", text }],
						api: "mock",
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: index,
					},
		),
	};
}

function trackedState(): ProviderSessionState & { closed: number } {
	const state = {
		closed: 0,
		close: () => {
			state.closed++;
		},
	};
	return state;
}

describe("AuthGatewaySessionStateStore", () => {
	it("follows a keyless conversation across turns and splits branches once they diverge", () => {
		const store = new AuthGatewaySessionStateStore();
		const first = store.acquire(keyless(turn("hi")));
		first.release();

		const continued = store.acquire(keyless(turn("hi", "hello", "next")));
		continued.release();
		expect(continued.states).toBe(first.states);

		// A sibling that shares only the opening no longer finds the ancestor.
		const sibling = store.acquire(keyless(turn("hi", "different reply", "next")));
		sibling.release();
		expect(sibling.states).not.toBe(first.states);

		// A client key names the conversation outright, whatever the history says.
		const keyed = store.acquire({ ...keyless(turn("unrelated")), clientKey: "conv-1" });
		keyed.release();
		const keyedAgain = store.acquire({ ...keyless(turn("other")), clientKey: "conv-1" });
		keyedAgain.release();
		expect(keyedAgain.states).toBe(keyed.states);
	});

	it("never evicts a leased entry and closes what it drops once released", () => {
		const store = new AuthGatewaySessionStateStore(1);
		const live = store.acquire({ ...keyless(turn("a")), clientKey: "live" });
		const liveState = trackedState();
		live.states.set("provider", liveState);

		const other = store.acquire({ ...keyless(turn("b")), clientKey: "other" });
		const otherState = trackedState();
		other.states.set("provider", otherState);
		// Both are leased: the store sits above its bound rather than closing live state.
		expect(store.size).toBe(2);
		expect(liveState.closed).toBe(0);

		live.release();
		expect(store.size).toBe(1);
		expect(liveState.closed).toBe(1);
		expect(otherState.closed).toBe(0);

		other.release();
		store.close();
		expect(otherState.closed).toBe(1);
		expect(store.size).toBe(0);
	});

	it("resets only account-scoped records when the credential account changes", () => {
		const store = new AuthGatewaySessionStateStore();
		const first = store.acquire({ ...keyless(turn("hi")), clientKey: "conv", account: "oauth:alice" });
		const anthropic = {
			strictToolsDisabled: true,
			fastModeDisabled: true,
			replayUnsignedThinkingDisabled: false,
			closed: 0,
			close() {
				this.closed++;
			},
		};
		first.states.set("anthropic-messages:https://api.anthropic.com\u0000claude-opus-4-7", anthropic);
		first.release();

		const sameAccount = store.acquire({ ...keyless(turn("hi")), clientKey: "conv", account: "oauth:alice" });
		sameAccount.release();
		expect(anthropic.fastModeDisabled).toBe(true);

		// Rotation onto a sibling account re-probes the fast-mode entitlement but
		// keeps the endpoint's strict-tools lesson and the retained map itself.
		const rotated = store.acquire({ ...keyless(turn("hi")), clientKey: "conv", account: "oauth:bob" });
		expect(rotated.states).toBe(first.states);
		expect(anthropic.fastModeDisabled).toBe(false);
		expect(anthropic.strictToolsDisabled).toBe(true);
		expect(anthropic.closed).toBe(0);

		// An in-request auth retry that lands on another account resets the same subset.
		anthropic.fastModeDisabled = true;
		rotated.updateAccount("oauth:carol");
		expect(anthropic.fastModeDisabled).toBe(false);
		rotated.release();
	});
});
