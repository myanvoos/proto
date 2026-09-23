import { describe, expect, it } from "bun:test";
import { getProviderDefinition } from "./registry";

function statusFetch(status: number): typeof fetch {
	const impl = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
		status === 200
			? Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] })
			: Response.json({ error: { message: "probe failed" } }, { status });
	return impl as typeof fetch;
}

async function loginStepfun(status: number): Promise<unknown> {
	return getProviderDefinition("stepfun")?.login?.({
		onAuth: () => {},
		onPrompt: async () => "  sf-key  ",
		fetch: statusFetch(status),
	});
}

describe("optional API key probe", () => {
	it("rejects a key the probe refuses with an auth failure", async () => {
		await expect(loginStepfun(401)).rejects.toThrow(/StepFun API key validation failed \(401\)/);
		await expect(loginStepfun(403)).rejects.toThrow(/\(403\)/);
	});

	it("keeps the key when the probe fails for a non-auth reason", async () => {
		expect(await loginStepfun(404)).toBe("sf-key");
		expect(await loginStepfun(503)).toBe("sf-key");
	});
});
