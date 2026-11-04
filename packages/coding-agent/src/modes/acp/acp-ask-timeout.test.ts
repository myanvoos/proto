import { afterEach, expect, test, vi } from "bun:test";
import type { AgentSideConnection, CreateElicitationResponse } from "@oh-my-pi/pi-utils/acp";
import { createAcpExtensionUiContext } from "./acp-agent";

afterEach(() => vi.useRealTimers());

test("ACP expiry returns no approval and a late accepted response cannot answer the next form", async () => {
	vi.useFakeTimers();
	const old = Promise.withResolvers<CreateElicitationResponse>();
	let current = old;
	const connection = { unstable_createElicitation: () => current.promise } as unknown as AgentSideConnection;
	const ui = createAcpExtensionUiContext(connection, () => "session", { elicitation: { form: {} } });
	const questions = [
		{ id: "publish", question: "Publish?", options: [{ label: "Yes" }, { label: "No" }], recommended: 0 },
	];
	const first = ui.askDialog!(questions, { timeout: 1000 });
	vi.advanceTimersByTime(1000);
	expect(await first).toMatchObject({ kind: "timeout", results: [{ selectedOptions: [], timedOut: true }] });
	current = Promise.withResolvers<CreateElicitationResponse>();
	const second = ui.askDialog!(questions, { timeout: 2000 });
	old.resolve({ action: "accept", content: { q0: "Yes" } });
	vi.advanceTimersByTime(1000);
	current.resolve({ action: "accept", content: { q0: "No" } });
	expect(await second).toMatchObject({ kind: "submit", results: [{ selectedOptions: ["No"] }] });
});
