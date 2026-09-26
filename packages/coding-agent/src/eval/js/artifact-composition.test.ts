import { afterEach, expect, test, vi } from "bun:test";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ArtifactManager } from "../../session/artifacts";
import type { ToolSession } from "../../tools";
import type { EvalArtifactRef } from "../artifact-values";
import { resolveEvalArtifact } from "../artifact-values";
import { JsRuntime } from "./shared/runtime";
import type { JsDisplayOutput } from "./shared/types";
import { callSessionTool } from "./tool-bridge";

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
afterEach(() => vi.restoreAllMocks());

test("displayed tool images remain artifact references usable by subsequent kernel completion without base64 printing", async () => {
	using tmp = TempDir.createSync("@artifact-composition-");
	const manager = new ArtifactManager(tmp.join("artifacts"));
	const model = {
		provider: "composition",
		id: "model",
		name: "model",
		api: "openai-completions",
		baseUrl: "https://provider.invalid",
		input: ["text", "image"],
		reasoning: false,
		compat: {},
	} as Model;
	const imageTool = {
		name: "composition_image",
		label: "image",
		description: "",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [
				{ type: "text" as const, text: "image metadata" },
				{ type: "image" as const, mimeType: "image/png", data: IMAGE },
			],
			details: { width: 1 },
		}),
	};
	const session = {
		cwd: tmp.path(),
		getToolByName: () => imageTool,
		getArtifactManager: () => manager,
		allocateOutputArtifact: (type: string) => manager.allocatePath(type),
		settings: { get: () => undefined },
		modelRegistry: {
			getAvailable: () => [model],
			getApiKey: async () => "test-only-key",
			resolver: () => async () => "test-only-key",
		},
	} as unknown as ToolSession;
	const response: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "one pixel" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
	const provider = vi.spyOn(agentCore, "instrumentedCompleteSimple").mockResolvedValue(response);
	const displays: JsDisplayOutput[] = [];
	const runtime = new JsRuntime({ initialCwd: tmp.path(), sessionId: crypto.randomUUID() });
	let stdout = "";
	try {
		const result = (await runtime.run(
			`
			const composedImage = await tool.composition_image({});
			const composedAnswer = await completion([{type:"text",text:"describe"}, composedImage.images[0]], {model:"composition/model"});
			({ image: composedImage.images[0], refs: composedImage.artifacts, details: composedImage.details, answer: composedAnswer })
		`,
			"artifact-composition.js",
			{
				onText: text => {
					stdout += text;
				},
				onDisplay: display => {
					displays.push(display);
				},
				callTool: (name, args) => callSessionTool(name, args, { session }),
			},
		)) as { image: EvalArtifactRef; refs: EvalArtifactRef[]; details: unknown; answer: string };
		expect(result.answer).toBe("one pixel");
		expect(result.details).toEqual({ width: 1 });
		expect(result.image).toEqual(result.refs[0]);
		expect(result.image.type).toBe("artifact");
		expect(JSON.stringify(result)).not.toContain(IMAGE);
		expect(stdout).not.toContain(IMAGE);
		expect(displays.filter(display => display.type === "image")).toEqual([
			{ type: "image", mimeType: "image/png", data: IMAGE },
		]);
		expect(Buffer.from((await resolveEvalArtifact(result.image, { session })).data).toString("base64")).toBe(IMAGE);
		expect(provider.mock.calls[0][1].messages[0].content).toEqual([
			{ type: "text", text: "describe" },
			{ type: "image", mimeType: "image/png", data: IMAGE },
		]);
	} finally {
		runtime.dispose();
	}
});
