import type { Api, Model, ToolChoice } from "@oh-my-pi/pi-ai";

export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model) return undefined;

	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		return { type: "tool", name: toolName };
	}

	// openrouter streams through the openai-responses or openai-completions path, both of which map a named choice.
	if (
		model.api === "openai-codex-responses" ||
		model.api === "openai-responses" ||
		model.api === "openai-completions" ||
		model.api === "azure-openai-responses" ||
		model.api === "openrouter"
	) {
		// The OpenAI transports drop tool_choice when the model has none and downgrade a forced choice to "auto" when
		// forcing is unsupported, so such a choice never reaches the wire and must not be reported as forced.
		const compat = model.compat as { supportsToolChoice?: boolean; supportsForcedToolChoice?: boolean } | undefined;
		if (compat?.supportsToolChoice === false || compat?.supportsForcedToolChoice === false) return undefined;
		return { type: "function", name: toolName };
	}

	if (model.api === "ollama-chat") {
		return { type: "function", name: toolName };
	}

	if (model.api === "google-generative-ai" || model.api === "google-gemini-cli" || model.api === "google-vertex") {
		return "required";
	}

	return undefined;
}

export function isToolChoiceActive(toolChoice: ToolChoice | undefined, tools: readonly { name: string }[]): boolean {
	if (!toolChoice || typeof toolChoice === "string") return true;
	if (toolChoice.type === "computer") return tools.some(tool => tool.name === "computer");
	const name =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;
	return tools.some(tool => tool.name === name);
}
