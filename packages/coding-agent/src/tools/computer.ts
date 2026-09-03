import { type Type, type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { isClaudeModelId } from "@oh-my-pi/pi-catalog/identity";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { once, prompt } from "@oh-my-pi/pi-utils";
import { callSessionTool } from "../eval/js/tool-bridge";
import computerDescription from "../prompts/tools/computer.md" with { type: "text" };
import { enforceInlineByteCap } from "../session/streaming-output";
import type { ComputerScreenshot, ComputerSessionSnapshot } from "./computer/protocol";
import { type ComputerController, ComputerSupervisor, registerComputerController } from "./computer/supervisor";
import type { ToolSession } from "./index";
import { ToolError, throwIfAborted } from "./tool-errors";
import { clampTimeout } from "./tool-timeouts";

const COORDINATE_SAFE_MAX_CAPTURE_WIDTH = 1280;
const COORDINATE_SAFE_MAX_CAPTURE_HEIGHT = 896;

function usesCoordinateSafeImageSizing(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	return (
		(!!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === false) ||
		isClaudeModelId(model.id) ||
		(model.requestModelId !== undefined && isClaudeModelId(model.requestModelId)) ||
		(typeof model.name === "string" && /^claude(?:\s|$)/i.test(model.name))
	);
}

interface ComputerToolInput {
	code: string;
	read_only?: boolean;
	timeout?: number;
}

type ComputerSchema = Type<ComputerToolInput>;

const getComputerSchema: () => ComputerSchema = once(() =>
	type({
		code: type("string").describe(
			"JavaScript executed in the persistent computer session; top-level await allowed; `desktop`, `wait`, `assert` in scope",
		),
		"read_only?": type("boolean").describe(
			"true = inspection only: screenshots and ax reads allowed, all input/mutation blocked",
		),
		"timeout?": type("number").describe("run budget in seconds"),
		"+": "reject",
	}),
);

export interface ComputerToolDetails {
	code?: string;
	readOnly?: boolean;
	screenshots: ComputerScreenshot[];
	returnValue?: string;
	backend?: string;
	capturePermission?: string;
	inputPermission?: string;
	axPermission?: string;
}

type ComputerControllerFactory = (session: ToolSession) => ComputerController;

export class ComputerTool implements AgentTool<ComputerSchema, ComputerToolDetails> {
	readonly name = "computer";
	readonly label = "Computer";
	readonly loadMode = "discoverable" as const;
	readonly concurrency = "exclusive" as const;
	readonly summary = "Control the host desktop with persistent JavaScript and OS accessibility APIs";
	readonly strict = false;

	readonly #controller: ComputerController;
	readonly #unregisterOwner: () => void;
	#closed = false;
	#description?: string;

	constructor(
		readonly session: ToolSession,
		createController: ComputerControllerFactory = currentSession =>
			new ComputerSupervisor(currentSession, undefined, undefined, callSessionTool),
	) {
		this.#controller = createController(session);
		this.#unregisterOwner = registerComputerController(
			session.getEvalKernelOwnerId?.() ?? undefined,
			this.#controller,
		);
	}

	get parameters(): ComputerSchema {
		return getComputerSchema();
	}

	get description(): string {
		this.#description ??= prompt.render(computerDescription);
		return this.#description;
	}

	async execute(
		_toolCallId: string,
		params: ComputerToolInput,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ComputerToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ComputerToolDetails>> {
		throwIfAborted(signal);
		if (this.#closed) throw new ToolError("Computer session is closed");

		const timeoutSeconds = clampTimeout("computer", params.timeout, this.session.settings.get("tools.maxTimeout"));
		const coordinateSafe = usesCoordinateSafeImageSizing(this.session.getActiveModel?.());
		const configuredMaxWidth = this.session.settings.get("computer.maxWidth");
		const configuredMaxHeight = this.session.settings.get("computer.maxHeight");
		const snapshot: ComputerSessionSnapshot = {
			cwd: this.session.cwd,
			sessionId: this.session.getEvalSessionId?.() ?? this.session.getSessionId?.() ?? "computer",
			captureMaxWidth: coordinateSafe
				? Math.min(configuredMaxWidth, COORDINATE_SAFE_MAX_CAPTURE_WIDTH)
				: configuredMaxWidth,
			captureMaxHeight: coordinateSafe
				? Math.min(configuredMaxHeight, COORDINATE_SAFE_MAX_CAPTURE_HEIGHT)
				: configuredMaxHeight,
			display: this.session.settings.get("computer.display") ?? "all",
			readOnly: !!params.read_only,
		};
		const run = await this.#controller.run(params.code, timeoutSeconds * 1000, snapshot, signal);
		throwIfAborted(signal);

		const details: ComputerToolDetails = {
			code: params.code,
			readOnly: snapshot.readOnly,
			screenshots: run.screenshots,
		};
		if (run.returnValue !== undefined) details.returnValue = stringifyReturnValue(run.returnValue);
		populateCapabilityDetails(details, run.capabilities);

		const textBlocks = run.displays
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map(content => content.text);
		if (details.returnValue !== undefined) textBlocks.push(details.returnValue);
		if (!textBlocks.length && !run.displays.some(content => content.type === "image")) {
			textBlocks.push("Ran computer code");
		}
		const textOnly = textBlocks.join("\n");
		const cappedText = await enforceInlineByteCap(textOnly, {
			saveArtifact: full => saveComputerOutputArtifact(this.session, full),
		});
		const images = run.displays
			.filter(content => content.type === "image")
			.map(content => ({ ...content, detail: "original" as const }));
		const content = [...(cappedText ? [{ type: "text" as const, text: cappedText }] : []), ...images];
		return { content, details };
	}

	async capabilities(): Promise<DesktopCapabilities | undefined> {
		if (this.#closed) return undefined;
		return await this.#controller.capabilities();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unregisterOwner();
		await this.#controller.close();
	}
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function populateCapabilityDetails(details: ComputerToolDetails, capabilities: DesktopCapabilities | undefined): void {
	if (!capabilities) return;
	details.backend = capabilities.backend;
	details.capturePermission = capabilities.capturePermission;
	details.inputPermission = capabilities.inputPermission;
	details.axPermission = capabilities.axPermission;
}

async function saveComputerOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("computer-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}
