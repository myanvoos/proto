import { afterEach, expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { ArtifactManager } from "../session/artifacts";
import type { ToolSession } from "../tools";
import { MAX_EVAL_ARTIFACT_BYTES, publishEvalArtifact } from "./artifact-values";
import { runEvalCompletion } from "./completion-bridge";
import { MAX_EVAL_COMPLETION_PARTS, MAX_EVAL_COMPLETION_TEXT_BYTES } from "./completion-content";

function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id, api: "openai-completions", reasoning: false } as unknown as Model<Api>;
}

/**
 * Resolution runs before any network call, and the missing-credential branch names the model it
 * settled on — so every assertion below observes the selected model without issuing a request.
 */
function stubSession(available: Model<Api>[], roles: Record<string, string> = {}): ToolSession {
	return {
		settings: { get: () => undefined, getModelRole: (role: string) => roles[role] },
		modelRegistry: { getAvailable: () => available, getApiKey: async () => undefined },
	} as unknown as ToolSession;
}

async function completionError(session: ToolSession, selector: string): Promise<string> {
	try {
		await runEvalCompletion({ prompt: "hi", model: selector }, { session });
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`expected completion(model: ${selector}) to reject`);
}

const AMBIGUOUS = [model("vendor-a", "shared-model"), model("vendor-b", "shared-model")];

test("a bare model id offered by several providers is rejected with qualified alternatives", async () => {
	expect(await completionError(stubSession(AMBIGUOUS), "shared-model")).toBe(
		'completion() model "shared-model" is ambiguous: vendor-a, vendor-b all provide it. Qualify it as "vendor-a/shared-model" or "vendor-b/shared-model".',
	);
});

test("a bare model id offered by one provider resolves to that provider", async () => {
	const session = stubSession([model("vendor-a", "solo-model"), model("vendor-b", "other-model")]);
	expect(await completionError(session, "solo-model")).toStartWith(
		"completion() has no API key for vendor-a/solo-model.",
	);
});

test("a provider-qualified reference picks that provider out of an ambiguous pool", async () => {
	expect(await completionError(stubSession(AMBIGUOUS), "vendor-b/shared-model")).toStartWith(
		"completion() has no API key for vendor-b/shared-model.",
	);
});

test("an id missing from the pool reports the pool's near matches", async () => {
	const session = stubSession([model("vendor-a", "claude-opus-5"), model("vendor-b", "gpt-6")]);
	expect(await completionError(session, "opus")).toBe(
		'completion() model "opus" is not in the model pool. Pass a tier ("tiny", "smol", "default", "slow") or an available model id. Closest available: vendor-a/claude-opus-5.',
	);
});

test("tier names still route through modelRoles instead of the model pool", async () => {
	const session = stubSession([model("vendor-a", "tiny-model"), model("vendor-b", "big-model")], {
		smol: "vendor-a/tiny-model",
	});
	expect(await completionError(session, "smol")).toStartWith("completion() has no API key for vendor-a/tiny-model.");
});

const PNG_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
const WAV_BYTES = Buffer.from("RIFF\x04\x00\x00\x00WAVE", "binary");
const VIDEO_BYTES = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);

afterEach(() => vi.restoreAllMocks());

function contentSession(
	cwd: string,
	api: Api = "openai-completions",
	input: Model["input"] = ["text", "image", "audio", "video"],
): ToolSession {
	const selected = {
		provider: "content-test",
		id: "model",
		name: "model",
		api,
		reasoning: false,
		input,
		baseUrl: "https://provider.invalid",
		compat: {},
	} as Model;
	const manager = new ArtifactManager(path.join(cwd, "artifacts"));
	return {
		cwd,
		getArtifactManager: () => manager,
		allocateOutputArtifact: (type: string) => manager.allocatePath(type),
		settings: { get: () => undefined },
		modelRegistry: {
			getAvailable: () => [selected],
			getApiKey: async () => "test-only-key",
			resolver: () => async () => "test-only-key",
		},
	} as unknown as ToolSession;
}

function providerResponse(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "provider result" }],
		api: "openai-completions",
		provider: "content-test",
		model: "model",
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function providerSpy() {
	return vi.spyOn(agentCore, "instrumentedCompleteSimple").mockResolvedValue(providerResponse());
}

test("text completion keeps its exact user content and text result at the provider boundary", async () => {
	using tmp = TempDir.createSync("@completion-text-");
	const session = contentSession(tmp.path());
	const call = providerSpy();
	const result = await runEvalCompletion({ prompt: " unchanged text\n", model: "content-test/model" }, { session });
	expect(call.mock.calls[0][1].messages).toEqual([
		{ role: "user", content: [{ type: "text", text: " unchanged text\n" }], timestamp: expect.any(Number) },
	]);
	expect(result.text).toBe("provider result");
});

test("mixed JSON and binary image artifacts reach the provider as typed content despite log storage suffix", async () => {
	using tmp = TempDir.createSync("@completion-artifacts-");
	const session = contentSession(tmp.path());
	const call = providerSpy();
	const json = await publishEvalArtifact({ kind: "json", value: { rows: 2 } }, { session });
	await Bun.write(tmp.join("input.png"), Buffer.from(PNG_DATA, "base64"));
	const image = await publishEvalArtifact({ kind: "binary", path: "input.png", mimeType: "image/png" }, { session });
	await runEvalCompletion(
		{
			prompt: [{ type: "text", text: "compare" }, json, { type: "image", artifact: image, detail: "high" }],
			model: "content-test/model",
		},
		{ session },
	);
	expect(await session.getArtifactManager!()!.getPath(image.uri.slice("artifact://".length))).toEndWith(".log");
	expect(call.mock.calls[0][1].messages[0].content).toEqual([
		{ type: "text", text: "compare" },
		{ type: "text", text: '{"rows":2}' },
		{ type: "image", mimeType: "image/png", data: PNG_DATA, detail: "high" },
	]);
	call.mockClear();
	await runEvalCompletion({ prompt: image, model: "content-test/model" }, { session });
	expect(call.mock.calls[0][1].messages[0].content).toEqual([
		{ type: "image", mimeType: "image/png", data: PNG_DATA },
	]);
});

test("Google audio and video artifacts preserve exact typed bytes alongside inline images", async () => {
	using tmp = TempDir.createSync("@completion-google-media-");
	const session = contentSession(tmp.path(), "google-generative-ai");
	const call = providerSpy();
	const audio = await publishEvalArtifact({ kind: "binary", value: WAV_BYTES, mimeType: "audio/wav" }, { session });
	const video = await publishEvalArtifact({ kind: "binary", value: VIDEO_BYTES, mimeType: "video/mp4" }, { session });
	await runEvalCompletion(
		{
			prompt: [
				{ type: "artifact", ref: audio },
				{ type: "video", artifact: video },
				{ type: "image", mimeType: "image/png", data: PNG_DATA },
			],
			model: "content-test/model",
		},
		{ session },
	);
	expect(call.mock.calls[0][1].messages[0].content).toEqual([
		{ type: "audio", mimeType: "audio/wav", data: WAV_BYTES.toString("base64") },
		{ type: "video", mimeType: "video/mp4", data: VIDEO_BYTES.toString("base64") },
		{ type: "image", mimeType: "image/png", data: PNG_DATA },
	]);
});

test("unsupported model modalities and adapters reject before the provider can silently omit media", async () => {
	using tmp = TempDir.createSync("@completion-modality-");
	const call = providerSpy();
	await expect(
		runEvalCompletion(
			{ prompt: [{ type: "image", mimeType: "image/png", data: PNG_DATA }], model: "content-test/model" },
			{
				session: contentSession(tmp.join("text"), "openai-completions", ["text"]),
			},
		),
	).rejects.toThrow("does not support image");
	await expect(
		runEvalCompletion(
			{
				prompt: [{ type: "audio", mimeType: "audio/wav", data: WAV_BYTES.toString("base64") }],
				model: "content-test/model",
			},
			{
				session: contentSession(tmp.join("responses"), "openai-responses"),
			},
		),
	).rejects.toThrow("provider API openai-responses does not support audio");
	const session = contentSession(tmp.join("guarded"));
	Object.assign(session.modelRegistry!.getAvailable()[0], { compat: { stripImageInput: true } });
	await expect(
		runEvalCompletion(
			{ prompt: [{ type: "image", mimeType: "image/png", data: PNG_DATA }], model: "content-test/model" },
			{ session },
		),
	).rejects.toThrow("does not send image");
	expect(call).not.toHaveBeenCalled();
});

test("unsupported formats, mismatched bytes, and ambient URL fields fail instead of coercing attachments", async () => {
	using tmp = TempDir.createSync("@completion-formats-");
	const session = contentSession(tmp.path());
	const call = providerSpy();
	const request = (part: unknown) => runEvalCompletion({ prompt: [part], model: "content-test/model" }, { session });
	await expect(request({ type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" })).rejects.toThrow(
		"Unsupported completion image MIME",
	);
	await expect(request({ type: "image", mimeType: "image/jpeg", data: PNG_DATA })).rejects.toThrow(
		"do not match MIME",
	);
	await expect(
		request({ type: "image", mimeType: "image/png", data: PNG_DATA, url: "https://provider.invalid/private" }),
	).rejects.toThrow("Unsupported completion content field: url");
	await expect(request({ type: "image", mimeType: "image/png", data: "!!!" })).rejects.toThrow("canonical base64");
	await expect(
		request({ type: "audio", mimeType: "audio/flac", data: Buffer.from("fLaC").toString("base64") }),
	).rejects.toThrow("only audio/wav or audio/mpeg");
	expect(call).not.toHaveBeenCalled();
});

test("completion enforces text, part count, media bytes, and aggregate bounds before provider calls", async () => {
	using tmp = TempDir.createSync("@completion-limits-");
	const session = contentSession(tmp.path());
	const call = providerSpy();
	const request = (prompt: unknown) => runEvalCompletion({ prompt, model: "content-test/model" }, { session });
	await expect(request("x".repeat(MAX_EVAL_COMPLETION_TEXT_BYTES + 1))).rejects.toThrow("text exceeds");
	await expect(
		request(Array.from({ length: MAX_EVAL_COMPLETION_PARTS + 1 }, () => ({ type: "text", text: "x" }))),
	).rejects.toThrow("content parts");
	await expect(
		request([
			{ type: "image", mimeType: "image/png", data: Buffer.alloc(MAX_EVAL_ARTIFACT_BYTES + 1).toString("base64") },
		]),
	).rejects.toThrow("byte limit");
	await expect(
		request(Array.from({ length: 21 }, () => ({ type: "text", text: "x".repeat(MAX_EVAL_COMPLETION_TEXT_BYTES) }))),
	).rejects.toThrow("total byte limit");
	expect(call).not.toHaveBeenCalled();
});

function fallbackSession(available: Model<Api>[], overrides: Record<string, unknown>): ToolSession {
	return {
		settings: Settings.isolated({ modelRoles: { smol: "p/smol" }, ...overrides }),
		modelRegistry: {
			getAvailable: () => available,
			find: (provider: string, id: string) => available.find(m => m.provider === provider && m.id === id),
			hasProvider: (provider: string) => available.some(m => m.provider === provider),
			getApiKey: async () => "test-only-key",
			resolver: () => async () => "test-only-key",
		},
	} as unknown as ToolSession;
}

/** Answers each model id with its scripted text or provider error; returns the model ids in attempt order. */
function scriptedProvider(outcomes: Record<string, string | Error>): string[] {
	const attempted: string[] = [];
	vi.spyOn(agentCore, "instrumentedCompleteSimple").mockImplementation(async selected => {
		attempted.push(selected.id);
		const outcome = outcomes[selected.id];
		const failed = outcome instanceof Error;
		return {
			role: "assistant",
			content: failed ? [] : [{ type: "text", text: outcome ?? "" }],
			api: "openai-completions",
			provider: selected.provider,
			model: selected.id,
			timestamp: 1,
			stopReason: failed ? "error" : "stop",
			errorMessage: failed ? outcome.message : undefined,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		} as AssistantMessage;
	});
	return attempted;
}

const FALLBACK_MODELS = ["smol", "b", "c"].map(id => model("p", id));

test("a failed tier model falls through its retry chain, including a fallback's own chain", async () => {
	const session = fallbackSession(FALLBACK_MODELS, { "retry.fallbackChains": { smol: ["p/b"], "p/b": ["p/c"] } });
	const attempted = scriptedProvider({ smol: new Error("quota exhausted"), b: new Error("b down"), c: "c answer" });
	const result = await runEvalCompletion({ prompt: "q", model: "smol" }, { session });
	expect(attempted).toEqual(["smol", "b", "c"]);
	expect(result.text).toBe("c answer");
	expect(result.details.model).toBe("p/c");
});

test("completion fallbacks stop at retry.maxRetries and terminate on cyclic chains", async () => {
	const down = { smol: new Error("always down"), b: new Error("always down"), c: new Error("always down") };
	const limited = fallbackSession(FALLBACK_MODELS, {
		"retry.fallbackChains": { smol: ["p/b", "p/c"] },
		"retry.maxRetries": 1,
	});
	let attempted = scriptedProvider(down);
	await expect(runEvalCompletion({ prompt: "q", model: "smol" }, { session: limited })).rejects.toThrow("always down");
	expect(attempted).toEqual(["smol", "b"]);

	vi.restoreAllMocks();
	const cyclic = fallbackSession(FALLBACK_MODELS, { "retry.fallbackChains": { smol: ["p/b"], "p/b": ["p/smol"] } });
	attempted = scriptedProvider(down);
	await expect(runEvalCompletion({ prompt: "q", model: "smol" }, { session: cyclic })).rejects.toThrow("always down");
	expect(attempted).toEqual(["smol", "b"]);
});

test("disabling model fallback keeps completion on the tier model", async () => {
	const session = fallbackSession(FALLBACK_MODELS, {
		"retry.fallbackChains": { smol: ["p/b"] },
		"retry.modelFallback": false,
	});
	const attempted = scriptedProvider({ smol: new Error("quota exhausted"), b: "unused" });
	await expect(runEvalCompletion({ prompt: "q", model: "smol" }, { session })).rejects.toThrow("quota exhausted");
	expect(attempted).toEqual(["smol"]);
});

test("a completion fan-out keeps at most 32 provider requests in flight", async () => {
	using tmp = TempDir.createSync("@completion-fanout-");
	const session = contentSession(tmp.path());
	const saturated = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let started = 0;
	vi.spyOn(agentCore, "instrumentedCompleteSimple").mockImplementation(async () => {
		started += 1;
		if (started === 32) saturated.resolve();
		await release.promise;
		return providerResponse();
	});
	const calls = Array.from({ length: 40 }, () =>
		runEvalCompletion({ prompt: "q", model: "content-test/model" }, { session }),
	);
	await saturated.promise;
	// Let every queued call run its pre-request work; none may reach the provider while 32 are held.
	for (let turn = 0; turn < 20; turn++) {
		const nextTurn = Promise.withResolvers<void>();
		setImmediate(nextTurn.resolve);
		await nextTurn.promise;
	}
	expect(started).toBe(32);
	release.resolve();
	expect((await Promise.all(calls)).map(result => result.text)).toEqual(Array(40).fill("provider result"));
	expect(started).toBe(40);
});
