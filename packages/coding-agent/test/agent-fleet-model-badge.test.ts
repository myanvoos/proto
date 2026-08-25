import { beforeEach, describe, expect, it } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { modelBadge } from "@oh-my-pi/pi-coding-agent/modes/components/agent-fleet-renderer";

function refWith(session: Partial<AgentSession> | null, history: AgentRef["history"]): AgentRef {
	return {
		id: "worker",
		displayName: "worker",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: session ? (session as AgentSession) : null,
		sessionFile: null,
		createdAt: 0,
		lastActivity: Date.now(),
		history,
	};
}

function plain(badge: string | undefined): string {
	return Bun.stripANSI(badge ?? "");
}

describe("fleet row model badge attribution", () => {
	beforeEach(() => {
		initTheme();
	});

	it("renders nothing when the session only carries an inherited configured model", () => {
		const ref = refWith({ model: { id: "ox-alpha-free", provider: "opencode-go" } as never }, undefined);
		expect(modelBadge(ref, undefined)).toBeUndefined();
	});

	it("renders the serving selector without its provider prefix", () => {
		const ref = refWith(
			{ servingModel: { selector: "opencode-go/ox-alpha-free", isFallback: false } } as never,
			undefined,
		);
		const badge = plain(modelBadge(ref, undefined));
		expect(badge).toContain("ox-alpha-free");
		expect(badge).not.toContain("opencode-go/");
	});

	it("marks a fallback serving model with the fallback arrow", () => {
		const ref = refWith(
			{ servingModel: { selector: "openai-codex/gpt-5.6-sol", isFallback: true } } as never,
			undefined,
		);
		const badge = plain(modelBadge(ref, undefined));
		expect(badge).toContain("fallback →");
		expect(badge).toContain("gpt-5.6-sol");
	});

	it("prefers observer-attributed resolution over the configured session model", () => {
		const ref = refWith({ model: { id: "ox-alpha-free", provider: "opencode-go" } as never }, undefined);
		const badge = plain(
			modelBadge(ref, {
				progress: { resolvedModel: "anthropic/claude-opus-4-6", resolvedModelIsFallback: false },
			} as never),
		);
		expect(badge).toContain("claude-opus-4-6");
	});
});
