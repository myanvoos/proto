import * as fs from "node:fs";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getProjectDir, isEnoent, isRecord, logger, prompt } from "@oh-my-pi/pi-utils";
import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	formatBackgroundNotice,
	raceJobSettlement,
	resolveAutoBackgroundWaitMs,
} from "../async";
import type { Settings } from "../config/settings";
import {
	cancelAllEvalCompletionSpeculation,
	cancelEvalCompletionSpeculation,
	startEvalCompletionSpeculation,
} from "../eval/completion-bridge";
import { fsObservationLedgerFor } from "../eval/fs-observations";
import { parseStreamedInputForCompletion, type StreamedKernelFailure } from "../eval/speculation";
import {
	type ExecutionMetadata,
	type ExecutionTimeoutMetadata,
	executionMetadataForResult,
} from "../session/execution-metadata";

export type { StreamedKernelFailure } from "../eval/speculation";

import { preflightStreamedInput } from "../eval/assertion-preflight";
import { type KernelShellBridgeHandle, registerKernelShellRun } from "../eval/shell-bridge";
import type { EvalCellResult, EvalStatusEvent } from "../eval/types";
import { applyDirenvPreflight, type BashResult, executeBash } from "../exec/bash-executor";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { formatExecutionMetadata } from "../modes/components/execution-shared";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { highlightCode, type Theme } from "../modes/theme/theme";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import { resolveSpawnPolicy } from "../task/spawn-policy";
import "./kernel-prelude";
import type {
	ClientBridgeTerminalExitStatus,
	ClientBridgeTerminalHandle,
	ClientBridgeTerminalOutput,
} from "../session/client-bridge";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../tui/output-block";
import { webpExclusionForModel } from "../utils/image-loading";
import { resizeImage } from "../utils/image-resize";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { checkBashCommandAllowlist } from "./bash-allowlist";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { type BashKernelCell, detectBashKernelCell } from "./bash-kernel-cell";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { resolveEvalBackends } from "./eval-backends";
import { EVAL_DEFAULT_PREVIEW_LINES, renderKernelCellLines } from "./eval-render";
import { invalidateGithubCacheForBashCommand } from "./gh-cache-invalidation";
import {
	formatStyledTruncationWarning,
	type OutputMeta,
	resolveInlineByteCapBudget,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
} from "./output-meta";
import { resolveToCwd } from "./path-utils";
import {
	capPreviewLines,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	expandKeyHint,
	formatToolWorkingDirectory,
	previewWindowRows,
	replaceTabs,
} from "./render-utils";
import { extractLeadingCdTarget } from "./shell-tokenize";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";
import { dispatchXdTarget, type XdBashDispatch, xdevListing } from "./xdev";

export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: [...shellConfig.args, finalLine] };
}

export function shellBuiltinsDisabled(settings: Settings): boolean {
	const raw = settings.getShellConfig().env?.PI_DISABLE_UUTILS_BUILTINS ?? Bun.env.PI_DISABLE_UUTILS_BUILTINS;
	return !!raw && raw !== "0" && raw.toLowerCase() !== "false";
}

const RG_PROGRAM = /^(?:rg|rgrep)$/;

/**
 * Advisory for grep habits that silently change meaning under rg: its -r is
 * --replace and consumes the next token as the replacement, so a grep-style
 * `-rn`/`-rl` cluster replaces matches with "n"/"l" instead of recursing with
 * line numbers / files-with-matches output. Returns a notice text or
 * undefined; advisory only — a genuine `--replace` use just sees the note.
 */
export function rgReplaceFlagNotice(command: string): string | undefined {
	for (const segment of command.split(/\n|[|;&]|\|\||&&/)) {
		const tokens = segment.trim().split(/\s+/).filter(Boolean);
		let index = 0;
		while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
		if (index >= tokens.length || !RG_PROGRAM.test(tokens[index]!)) continue;
		for (const token of tokens.slice(index + 1)) {
			if (token === "--") break;
			if (!token.startsWith("-") || token.startsWith("--") || token === "-") continue;
			if (token.includes("r")) {
				return "note: rg's -r is --replace (grep's -rn/-rl habits don't transfer) — line numbers: -n, files-with-matches: -l, recursion is rg's default";
			}
		}
	}
	return undefined;
}

export function kernelBridgeAvailable(session: ToolSession): boolean {
	if (shellBuiltinsDisabled(session.settings)) return false;
	const backends = resolveEvalBackends(session);
	return backends.python || backends.js;
}

async function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("bash-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, originalText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

const BASH_TIMEOUT_DESCRIPTION = `timeout in seconds; 0 disables the command deadline; nonzero values are clamped to ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}`;

const bashSchemaBase = type({
	command: type("string").describe("command to execute"),
	"env?": type({ "[string]": "string" }).describe("extra env vars"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": type("string").describe("working directory"),
	"pty?": type("boolean").describe("run in pty mode"),
});

const bashSchemaWithAsync = type({
	command: "string",
	"env?": { "[string]": "string" },
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": type("boolean").describe("run in background"),
});

type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;

	async?: boolean;
	pty?: boolean;
}

export interface BashToolDetails {
	xdev?: unknown;
	meta?: OutputMeta;
	execution?: ExecutionMetadata;
	statusEvents?: EvalStatusEvent[];
	jsonOutputs?: unknown[];
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;

	exitCode?: number;

	timedOut?: boolean;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	stopUpdates: () => void;
}

interface StreamedBashState {
	generation: number;
	latestRaw: string;
	version: number;
	specContextKey?: string;
	specCandidateKey?: string;
	speculationLaunches: number;
	speculationStarted: Set<string>;
	assertionController?: AbortController;
	assertionPromise?: Promise<StreamedKernelFailure | undefined>;
}

interface XdDispatchRecord {
	xdev?: unknown;
	details?: { jsonOutputs?: unknown[] };
	content?: unknown[];
	isError?: boolean;
}

function parseXdDispatches(dispatches: readonly string[] | undefined): {
	records: XdDispatchRecord[];
	error?: string;
} {
	if (!dispatches) return { records: [] };
	const records: XdDispatchRecord[] = [];
	for (let index = 0; index < dispatches.length; index++) {
		const raw = dispatches[index];
		if (typeof raw !== "string") {
			return { records, error: `xd dispatch record ${index + 1} is not text` };
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed)) return { records, error: `xd dispatch record ${index + 1} is not an object` };
			records.push({
				xdev: parsed.xdev,
				details: isRecord(parsed.details)
					? { jsonOutputs: Array.isArray(parsed.details.jsonOutputs) ? parsed.details.jsonOutputs : undefined }
					: undefined,
				content: Array.isArray(parsed.content) ? parsed.content : undefined,
				isError: parsed.isError === true,
			});
		} catch (error) {
			return {
				records,
				error: `xd dispatch record ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	return { records };
}

function readXdDispatches(result: BashResult | BashInteractiveResult): readonly string[] | undefined {
	if (!("xdDispatches" in result) || !Array.isArray(result.xdDispatches)) return undefined;
	return result.xdDispatches;
}
function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env || Object.keys(env).length === 0) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!BASH_ENV_NAME_PATTERN.test(key)) {
			throw new ToolError(`Invalid bash env name: ${key}`);
		}
		normalized[key] = value;
	}
	return normalized;
}

function escapeBashEnvValueForDisplay(value: unknown): string {
	return String(value)
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function formatBashEnvAssignments(env: Record<string, unknown> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
				output += '"';
				break;
			case "\\":
				output += "\\";
				break;
			case "/":
				output += "/";
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
					output += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					output += "\\u";
				}
				break;
			}
			default:
				output += next;
		}
	}
	return output;
}

function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	if (envStart === -1) return undefined;
	const objectStart = partialJson.indexOf("{", envStart);
	if (objectStart === -1) return undefined;
	const envBody = partialJson.slice(objectStart + 1);
	const env: Record<string, string> = {};
	const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
	for (const match of envBody.matchAll(matcher)) {
		env[match[1]!] = unescapePartialJsonString(match[2]!);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function formatTimeoutClampNotice(
	requestedTimeoutSec: number,
	effectiveTimeoutSec: number,
	maxTimeout: number,
): string | undefined {
	if (requestedTimeoutSec === effectiveTimeoutSec) return undefined;
	const cappedByGlobal = maxTimeout > 0 && effectiveTimeoutSec === maxTimeout && maxTimeout < TOOL_TIMEOUTS.bash.max;
	const limit = cappedByGlobal
		? `global tools.maxTimeout ceiling ${maxTimeout}s`
		: `allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s`;
	return `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; ${limit}).`;
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

function formatWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

function formatExitCodeNotice(exitCode: number): string {
	return `Command exited with code ${exitCode}`;
}

function stripTrailingNotice(text: string, notice: string): string {
	const idx = text.lastIndexOf(notice);
	if (idx === -1) return text;
	let start = idx;
	let end = idx + notice.length;
	if (text[start - 1] === "\n") start -= 1;
	if (text[end] === "\n") end += 1;
	return (text.slice(0, start) + text.slice(end)).trimEnd();
}

function stripWallTimeNotice(text: string, wallTimeMs: number | undefined): string {
	if (wallTimeMs === undefined) return text;
	return stripTrailingNotice(text, formatWallTimeNotice(wallTimeMs));
}

function stripExitCodeNotice(text: string, exitCode: number | undefined): string {
	if (exitCode === undefined) return text;
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode));
}

function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (async?.state !== "running") return text;
	return stripTrailingNotice(text, formatBackgroundNotice(async.jobId));
}

export class BashTool implements AgentTool<typeof bashSchemaBase | typeof bashSchemaWithAsync, BashToolDetails> {
	readonly name = "bash";
	readonly label = "Bash";
	readonly loadMode = "essential";
	get description(): string {
		const evalBackends = resolveEvalBackends(this.session);
		const isToolActive = (name: string, fallback: boolean): boolean => this.session.isToolActive?.(name) ?? fallback;
		const bridge = kernelBridgeAvailable(this.session);
		const spawnPolicy = resolveSpawnPolicy(this.session.getSessionSpawns?.() ?? "*");
		return prompt.render(bashDescription, {
			asyncEnabled: this.#asyncEnabled,
			autoBackgroundEnabled: this.#autoBackgroundEnabled,
			autoBackgroundThresholdSeconds: Math.max(0, Math.floor(this.#autoBackgroundThresholdMs / 1000)),
			hasRead: isToolActive("read", true),
			hasLaunch: isToolActive("fleet", this.session.settings.get("launch.enabled")),
			hasEval: isToolActive("eval", evalBackends.python || evalBackends.js),
			hasShellBuiltins: !shellBuiltinsDisabled(this.session.settings),
			hasKernelBridge: bridge,
			py: bridge && evalBackends.python,
			js: bridge && evalBackends.js,
			spawns: spawnPolicy.enabled,
			spawnDefaultAgent: spawnPolicy.defaultAgent,
			spawnAllowedAgentsText: spawnPolicy.allowedPromptText,
		});
	}
	readonly parameters: BashToolSchema;

	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;
	readonly #asyncEnabled: boolean;
	readonly #autoBackgroundEnabled: boolean;
	readonly #autoBackgroundThresholdMs: number;
	readonly #streamedInputs = new Map<string, StreamedBashState>();
	#nextStreamGeneration = 0;
	#disposed = false;

	constructor(private readonly session: ToolSession) {
		this.#asyncEnabled = this.session.settings.get("async.enabled");
		this.#autoBackgroundEnabled = this.session.settings.get("bash.autoBackground.enabled");
		this.#autoBackgroundThresholdMs = Math.max(
			0,
			Math.floor(
				this.session.settings.get("bash.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
			),
		);
		this.parameters = this.#asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
		this.session.registerDisposeCallback?.(() => {
			this.#disposed = true;
			this.cancelStreamedInput();
		});
	}

	/**
	 * Observe an incremental tool-call argument JSON prefix. Only the explicit
	 * speculation/assertion settings enable work; malformed or unsupported
	 * prefixes are inert. A failure is returned only if it still belongs to the
	 * newest prefix for this outer call and generation.
	 */
	async observeStreamedInput(toolCallId: string, rawPartialJson: string): Promise<StreamedKernelFailure | undefined> {
		if (this.#disposed || !toolCallId || typeof rawPartialJson !== "string") return undefined;
		let state = this.#streamedInputs.get(toolCallId);
		if (!state) {
			state = {
				generation: ++this.#nextStreamGeneration,
				latestRaw: "",
				version: 0,
				speculationLaunches: 0,
				speculationStarted: new Set(),
			};
			this.#streamedInputs.set(toolCallId, state);
		}
		if (state.latestRaw === rawPartialJson) return state.assertionPromise ? await state.assertionPromise : undefined;
		state.latestRaw = rawPartialJson;
		state.version++;
		state.assertionController?.abort();
		state.assertionController = undefined;
		state.assertionPromise = undefined;

		const speculationEnabled = this.session.settings.get("kernel.speculation.enabled") === true;
		if (!speculationEnabled) {
			cancelEvalCompletionSpeculation(toolCallId, state.generation, this.session);
		} else {
			const parsed = parseStreamedInputForCompletion(rawPartialJson);
			const envKey = Object.entries(parsed.input.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
			const contextKey = JSON.stringify({
				cwd: parsed.input.cwd,
				env: envKey,
				pty: parsed.input.pty ?? false,
				async: parsed.input.async ?? false,
			});
			const candidateKey = parsed.calls.map(call => call.fingerprint).join("\0");
			if (state.specContextKey !== undefined && state.specContextKey !== contextKey) {
				cancelEvalCompletionSpeculation(toolCallId, state.generation, this.session);
			}
			if (state.specCandidateKey !== undefined) {
				const previousCandidates = state.specCandidateKey.length > 0 ? state.specCandidateKey.split("\0") : [];
				const removedOrRevised =
					parsed.calls.length < previousCandidates.length ||
					previousCandidates.some((fingerprint, index) => parsed.calls[index]?.fingerprint !== fingerprint);
				if (removedOrRevised) cancelEvalCompletionSpeculation(toolCallId, state.generation, this.session);
			}
			state.specContextKey = contextKey;
			state.specCandidateKey = candidateKey;
			if (parsed.input.pty === true || parsed.input.async === true || parsed.calls.length === 0) {
				cancelEvalCompletionSpeculation(toolCallId, state.generation, this.session);
			} else {
				const candidateFingerprints = parsed.calls.map(call => call.fingerprint);
				for (const call of parsed.calls) {
					if (state.speculationLaunches >= 2) break;
					const launchKey = `${call.index}\0${call.fingerprint}\0${contextKey}`;
					if (state.speculationStarted.has(launchKey)) continue;
					state.speculationStarted.add(launchKey);
					state.speculationLaunches++;
					void startEvalCompletionSpeculation({
						session: this.session,
						toolCallId,
						generation: state.generation,
						invocationId: String(call.index),
						fingerprint: call.fingerprint,
						args: call.args,
						language: call.language,
						candidateFingerprints,
					}).catch(() => undefined);
				}
			}
		}

		if (this.session.settings.get("kernel.assertPreflight.enabled") !== true) return undefined;
		const controller = new AbortController();
		state.assertionController = controller;
		const version = state.version;
		const assertion = preflightStreamedInput(toolCallId, rawPartialJson, {
			session: this.session,
			signal: controller.signal,
		})
			.then(failure => {
				const current = this.#streamedInputs.get(toolCallId);
				if (
					controller.signal.aborted ||
					current !== state ||
					current.version !== version ||
					current.latestRaw !== rawPartialJson
				)
					return undefined;
				return failure;
			})
			.catch(() => undefined);
		state.assertionPromise = assertion;
		return await assertion;
	}

	cancelStreamedInput(toolCallId?: string): void {
		const ids = toolCallId === undefined ? [...this.#streamedInputs.keys()] : [toolCallId];
		for (const id of ids) {
			const state = this.#streamedInputs.get(id);
			if (!state) continue;
			state.assertionController?.abort();
			cancelEvalCompletionSpeculation(id, state.generation, this.session);
			this.#streamedInputs.delete(id);
		}
		if (toolCallId === undefined) cancelAllEvalCompletionSpeculation(this.session);
	}

	async #dispatchParsedXd(
		parsed: XdBashDispatch,
		toolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BashToolDetails> | undefined,
		ctx: AgentToolContext | undefined,
		cwd?: string,
	): Promise<AgentToolResult<BashToolDetails> | undefined> {
		if (parsed.kind === "listing") {
			const xdev = this.session.xdev;
			const text = xdev
				? xdevListing(xdev)
				: "xd:// is not mounted in this session. Enable tools.xdev to mount discoverable tools as xd:// devices.";
			return { content: [{ type: "text", text }], details: {} };
		}
		return (await dispatchXdTarget(this.session, parsed.name, parsed.content, {
			toolCallId,
			signal,
			onUpdate: onUpdate as AgentToolUpdateCallback | undefined,
			context: ctx,
			cwd,
		})) as AgentToolResult<BashToolDetails>;
	}

	#createXdDispatcher(
		toolCallId: string,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<BashToolDetails> | undefined,
		ctx: AgentToolContext | undefined,
	): (request: string) => Promise<string> {
		let invocation = 0;
		return async requestText => {
			throwIfAborted(signal);
			let request: {
				name?: string | null;
				args?: string[];
				cwd?: string;
			};
			try {
				const parsed: unknown = JSON.parse(requestText);
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
					throw new Error("request must be an object");
				request = parsed as typeof request;
				if (request.name !== undefined && request.name !== null && typeof request.name !== "string") {
					throw new Error("name must be a string or null");
				}
				if (
					request.args !== undefined &&
					(!Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string"))
				) {
					throw new Error("args must be an array of strings");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return JSON.stringify({
					stdout: "",
					stderr: `xd: invalid dispatcher request: ${message}\n`,
					exitCode: 125,
				});
			}
			throwIfAborted(signal);
			const args = request.args ?? [];
			const parsed: XdBashDispatch = request.name
				? { kind: "device", name: request.name, content: args.join(" ") }
				: { kind: "listing" };
			let result: AgentToolResult<BashToolDetails> | undefined;
			try {
				result = await this.#dispatchParsedXd(
					parsed,
					`${toolCallId}:xd:${invocation++}`,
					signal,
					onUpdate,
					ctx,
					request.cwd,
				);
				throwIfAborted(signal);
			} catch (error) {
				if (
					error instanceof ToolAbortError ||
					signal?.aborted ||
					(error instanceof Error && error.name === "AbortError")
				)
					throw error;
				const message = error instanceof Error ? error.message : String(error);
				return JSON.stringify({ stdout: "", stderr: `xd: dispatcher failed: ${message}\n`, exitCode: 125 });
			}
			if (!result) {
				return JSON.stringify({ stdout: "", stderr: "xd: dispatcher returned no result\n", exitCode: 125 });
			}
			const text = result.content
				.filter(block => block.type === "text")
				.map(block => block.text ?? "")
				.join("");
			const nonText = result.content.filter(block => block.type !== "text");
			const isError = result.isError === true;
			let record: string | undefined;
			try {
				record = JSON.stringify({ xdev: result.details?.xdev, details: result.details, content: nonText, isError });
			} catch {
				record = JSON.stringify({
					xdev: result.details?.xdev,
					content: [],
					isError,
					recordError: "non-text result was not serializable",
				});
			}
			return JSON.stringify({
				stdout: isError ? "" : text,
				stderr: isError ? text : "",
				exitCode: isError ? 1 : 0,
				record,
			});
		};
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		return outputText || "(no output)";
	}

	#throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): void {
		if (result.cancelled) {
			const out = normalizeResultOutput(result);
			const annotated = out.startsWith("[Command cancelled]") ? out : out ? `${out}\n\n[Command aborted]` : out;
			throw new ToolError(annotated || "Command aborted");
		}
		if (result.timedOut === true) {
			const out = normalizeResultOutput(result);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(out ? `${out}\n\n[${message}]` : message);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status`);
		}
	}

	#kernelShellBridge(
		toolCallId: string,
		finalInput: { command: string; cwd?: string; env?: Record<string, string>; pty: boolean; async: boolean },
		onStatusEvent?: (event: EvalStatusEvent) => void,
	): KernelShellBridgeHandle | undefined {
		if (!kernelBridgeAvailable(this.session)) return undefined;
		const state =
			this.session.settings.get("kernel.speculation.enabled") === true
				? this.#streamedInputs.get(toolCallId)
				: undefined;
		let claimable = false;
		if (state) {
			const streamed = parseStreamedInputForCompletion(state.latestRaw);
			const streamedEnv = streamed.input.env ?? {};
			const finalEnv = finalInput.env ?? {};
			const sameEnv =
				Object.keys(streamedEnv).length === Object.keys(finalEnv).length &&
				Object.entries(finalEnv).every(([key, value]) => streamedEnv[key] === value);
			claimable =
				streamed.input.command === finalInput.command &&
				streamed.input.cwd === finalInput.cwd &&
				(streamed.input.pty ?? false) === finalInput.pty &&
				(streamed.input.async ?? false) === finalInput.async &&
				sameEnv;
		}
		return registerKernelShellRun(this.session, onStatusEvent, {
			toolCallId: claimable ? toolCallId : undefined,
			generation: claimable ? state?.generation : undefined,
		});
	}

	async #drainBridgeImages(bridge: KernelShellBridgeHandle | undefined): Promise<ImageContent[]> {
		const raw = bridge?.drainImages() ?? [];
		if (raw.length === 0) return [];
		const excludeWebP = webpExclusionForModel(this.session.getActiveModel?.());
		const images: ImageContent[] = [];
		for (const image of raw) {
			const resized = await resizeImage(image, { excludeWebP });
			images.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return images;
	}

	#recordFsObservations(result: BashResult | BashInteractiveResult): void {
		if (!("fsObservations" in result) || !result.fsObservations?.length) return;
		fsObservationLedgerFor(this.session).recordAll(
			result.fsObservations.map(observation => ({
				path: observation.path,
				kind: observation.kind,
				mtimeNs: observation.mtimeNs ?? null,
				size: observation.size ?? null,
			})),
		);
	}

	async #buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			terminalId?: string;
			wallTimeMs?: number;
			images?: readonly ImageContent[];
			statusEvents?: readonly EvalStatusEvent[];
			jsonOutputs?: readonly unknown[];
			xdDispatches?: readonly string[];
		} = {},
	): Promise<AgentToolResult<BashToolDetails>> {
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;
		const isTimeout = result.timedOut === true;
		const observedSignal = "signal" in result ? result.signal : undefined;
		const observedExecution = "execution" in result ? result.execution : undefined;
		const executionTimeout: ExecutionTimeoutMetadata | undefined = isTimeout
			? {
					cause: "deadline",
					scope: "command",
					requestedMs: options.requestedTimeoutSec !== undefined ? options.requestedTimeoutSec * 1000 : undefined,
					effectiveMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
				}
			: undefined;
		const execution =
			observedExecution ??
			executionMetadataForResult(
				{ exitCode, cancelled: result.cancelled, timedOut: isTimeout, signal: observedSignal },
				{
					elapsedMs: options.wallTimeMs,
					timeout: executionTimeout,
					summary: { ...result, collector: result.collector ?? { state: "complete" } },
				},
			);

		const xdResult = parseXdDispatches(options.xdDispatches ?? readXdDispatches(result));
		const xdImages: ImageContent[] = [];
		const xdJsonOutputs: unknown[] = [];
		const xdValues: unknown[] = [];
		let xdTransportFailure = false;
		for (const record of xdResult.records) {
			if (record.xdev !== undefined) xdValues.push(record.xdev);
			// A failed intermediate xd tool is data; final shell status remains authoritative.
			for (const value of record.details?.jsonOutputs ?? []) xdJsonOutputs.push(value);
			for (const block of record.content ?? []) {
				if (
					isRecord(block) &&
					block.type === "image" &&
					typeof block.data === "string" &&
					typeof block.mimeType === "string"
				) {
					xdImages.push({ type: "image", data: block.data, mimeType: block.mimeType });
				}
			}
		}
		if (xdResult.error) {
			xdTransportFailure = true;
			if (execution.collector.state !== "failed") {
				execution.collector = { state: "failed", error: xdResult.error };
			}
		}

		const outputLines = [this.#formatResultOutput(result)];
		const notices: string[] = [];
		if (options.wallTimeMs !== undefined) {
			notices.push(formatWallTimeNotice(options.wallTimeMs));
		}
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		if (notices.length > 0) outputLines.push("", ...notices);
		if (failedExit) outputLines.push("", formatExitCodeNotice(exitCode));
		const outputText = outputLines.join("\n");

		const details: BashToolDetails = { execution };
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (options.terminalId !== undefined) {
			details.terminalId = options.terminalId;
		}
		if (options.wallTimeMs !== undefined) {
			details.wallTimeMs = options.wallTimeMs;
		}
		if (options.statusEvents?.length) {
			details.statusEvents = [...options.statusEvents];
		}
		if (options.jsonOutputs?.length || xdJsonOutputs.length > 0) {
			details.jsonOutputs = [...(options.jsonOutputs ?? []), ...xdJsonOutputs];
		}
		if (xdValues.length > 0) {
			details.xdev = xdValues.length === 1 ? xdValues[0] : xdValues;
		}
		if (xdTransportFailure) {
			details.execution = {
				...execution,
				collector: { state: "failed", error: xdResult.error ?? "xd dispatch failed" },
			};
		}
		if (failedExit) {
			details.exitCode = exitCode;
		}

		let inlineArtifactId = result.artifactId;
		let inlineCapApplied = false;
		const inlineCap = {
			maxBytes: resolveInlineByteCapBudget(this.session.settings),
			saveArtifact: async (full: string): Promise<string | undefined> => {
				inlineCapApplied = true;
				if (result.artifactId) return result.artifactId;
				inlineArtifactId = await saveBashOriginalArtifact(this.session, full);
				return inlineArtifactId;
			},
		};
		const updateExecutionOutput = (): void => {
			if (!details.execution) return;
			const output = details.execution.output ?? { disposition: "unavailable" as const };
			details.execution = {
				...details.execution,
				output: {
					...output,
					...(inlineCapApplied
						? {
								disposition: "truncated" as const,
								truncated: true,
								rawArtifactId: inlineArtifactId ?? output.rawArtifactId,
							}
						: inlineArtifactId !== undefined
							? { rawArtifactId: inlineArtifactId }
							: {}),
				},
			};
		};

		if (isTimeout) {
			details.timedOut = true;
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;

			if (!normalizeResultOutput(result).startsWith(`[${message}]\n`)) {
				outputLines.push("", `[${message}]`);
			}
			const timeoutOutputText = await enforceInlineByteCap(outputLines.join("\n"), inlineCap);
			updateExecutionOutput();
			return toolResult(details)
				.content([{ type: "text", text: timeoutOutputText }, ...(options.images ?? []), ...xdImages])
				.truncationFromSummary(result, { direction: "tail" })
				.error()
				.done();
		}

		this.#throwIfUnfinished(result, timeoutSec, outputText);

		const cappedOutputText = await enforceInlineByteCap(outputText, inlineCap);
		updateExecutionOutput();

		const resultBuilder = toolResult(details).truncationFromSummary(result, { direction: "tail" });
		const contentImages = [...(options.images ?? []), ...xdImages];
		resultBuilder.content([{ type: "text", text: cappedOutputText }, ...contentImages]);
		if (failedExit || xdTransportFailure) resultBuilder.error();
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		previewText: string,
		timeoutSec: number | undefined,
		options: { requestedTimeoutSec?: number; notices?: readonly string[] } = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			execution: {
				state: "running",
				collector: { state: "complete" },
				output: { disposition: previewText.length > 0 ? "complete" : "unavailable" },
			},
			async: { state: "running", jobId, type: "bash" },
		};
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(formatBackgroundNotice(jobId));
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number | undefined;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices?: readonly string[];

		resolvedEnv?: Record<string, string>;
		xd?: {
			callId?: string;
			createDispatcher: (signal?: AbortSignal) => (request: string) => Promise<string>;
		};
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		forwardUpdates: boolean;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		let latestText = "";
		let forwardUpdates = options.forwardUpdates;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
				const wallTimeStart = performance.now();
				const pyBridge = this.#kernelShellBridge(jobId, {
					command: options.command,
					cwd: options.commandCwd,
					env: options.resolvedEnv,
					pty: false,
					async: true,
				});
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${jobId}`,
						timeout: options.timeoutMs ?? 0,
						signal: runSignal,
						env: pyBridge ? { ...options.resolvedEnv, ...pyBridge.env } : options.resolvedEnv,
						xd: options.xd,
						artifactPath,
						artifactId,
						onChunk: chunk => {
							tailBuffer.append(chunk);
							latestText = tailBuffer.text();
							void reportProgress(latestText, { async: { state: "running", jobId, type: "bash" } });
						},
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
					this.#recordFsObservations(result);
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices: options.notices ?? [],
						wallTimeMs,
						images: await this.#drainBridgeImages(pyBridge),
						statusEvents: pyBridge?.drainStatusEvents(),
						jsonOutputs: pyBridge?.drainJsonOutputs(),
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;

					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						throw new ToolError(finalText);
					}
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "bash" } });
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "bash" } });
					throw error;
				} finally {
					pyBridge?.dispose();
				}
			},
			{
				ownerId: this.session.getAsyncJobOwnerId?.() ?? this.session.getAgentId?.() ?? undefined,
				onProgress: async text => {
					latestText = text;
					if (!forwardUpdates) return;
					await options.onUpdate?.({
						content: [{ type: "text", text }],
						details: {
							execution: {
								state: "running",
								collector: { state: "running" },
								renderer: { state: "not-run" },
								output: { disposition: "complete" },
							},
							async: { state: "running", jobId, type: "bash" },
						},
					});
				},
			},
		);

		return {
			jobId,
			completion: completion.promise,
			getLatestText: () => latestText,
			stopUpdates: () => {
				forwardUpdates = false;
			},
		};
	}

	async execute(
		_toolCallId: string,
		{
			command: rawCommand,
			env: rawEnv,
			timeout: rawTimeout = 300,
			cwd,

			async: asyncRequested = false,
			pty = false,
		}: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		if (this.session.settings.get("kernel.speculation.enabled") !== true) {
			this.cancelStreamedInput(_toolCallId);
		}
		if (signal) {
			signal.addEventListener("abort", () => this.cancelStreamedInput(_toolCallId), { once: true });
		}
		let command = rawCommand;
		const env = normalizeBashEnv(rawEnv);
		const xdBridge = this.session.xdev
			? {
					callId: _toolCallId,
					createDispatcher: (dispatchSignal?: AbortSignal) =>
						this.#createXdDispatcher(_toolCallId, dispatchSignal, onUpdate, ctx),
				}
			: undefined;

		if (!cwd) {
			const cd = extractLeadingCdTarget(command);
			if (cd) {
				cwd = cd.path;
				command = cd.rest;
			}
		}
		if (asyncRequested && !this.#asyncEnabled) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		const bashPolicy = this.session.bashCommandPolicy;
		const bashAllowlist = this.session.bashCommandAllowlist;
		if (bashPolicy) {
			const verdict = bashPolicy(command);
			if (!verdict.allowed) throw new ToolError(verdict.reason ?? "Command blocked by the bash policy.");
		} else if (bashAllowlist) {
			const verdict = checkBashCommandAllowlist(command, bashAllowlist);
			if (!verdict.allowed) throw new ToolError(verdict.reason ?? "Command blocked by the bash allowlist.");
		}

		if (this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const commandsToCheck = rawCommand === command ? [command] : [rawCommand, command];
			for (const commandToCheck of commandsToCheck) {
				const interception = checkBashInterception(commandToCheck, ctx?.toolNames ?? [], rules, rawCommand);
				if (interception.block) {
					throw new ToolError(interception.message ?? "Command blocked");
				}
			}
		}

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills ?? [],
			attachments: this.session.getImageAttachments?.() ?? [],
			internalRouter: InternalUrlRouter.instance(),
			cwd: this.session.cwd,
			localOptions: {
				getArtifactsDir: this.session.getArtifactsDir,
				getSessionId: this.session.getSessionId,
			},
		};
		command = await expandInternalUrls(command, { ...internalUrlOptions, ensureLocalParentDirs: true });
		const resolvedEnv = env
			? Object.fromEntries(
					await Promise.all(
						Object.entries(env).map(async ([key, value]) => [
							key,
							await expandInternalUrls(value, {
								...internalUrlOptions,
								ensureLocalParentDirs: true,
								noEscape: true,
							}),
						]),
					),
				)
			: undefined;

		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		invalidateGithubCacheForBashCommand(command);

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}

		const requestedTimeoutSec = rawTimeout;
		const timeoutDisabled = requestedTimeoutSec === 0;
		const maxTimeout = this.session.settings.get("tools.maxTimeout");
		const timeoutSec = timeoutDisabled ? undefined : clampTimeout("bash", requestedTimeoutSec, maxTimeout);
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		const pendingNotices: string[] = [];
		const rgNotice = rgReplaceFlagNotice(command);
		if (rgNotice) pendingNotices.push(rgNotice);
		if (timeoutSec !== undefined) {
			const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec, maxTimeout);
			if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);
		}

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				xd: xdBridge,
				resolvedEnv,
				onUpdate,
				forwardUpdates: false,
			});
			return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		const clientBridge = this.session.getClientBridge?.();
		const bridgeTerminalAvailable = Boolean(
			clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty,
		);

		const autoBgManager = this.session.asyncJobManager;

		if (
			this.#autoBackgroundEnabled &&
			!pty &&
			!bridgeTerminalAvailable &&
			autoBgManager &&
			!autoBgManager.atCapacity
		) {
			const autoBackgroundWaitMs = resolveAutoBackgroundWaitMs(this.#autoBackgroundThresholdMs, timeoutMs);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				xd: xdBridge,
				resolvedEnv,
				onUpdate,
				forwardUpdates: !startBackgrounded,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
				});
			}

			autoBgManager.acknowledgeDeliveries([job.jobId]);
			const waitResult = await raceJobSettlement(
				job.completion,
				autoBackgroundWaitMs,
				signal,
				ctx?.toolCall?.steeringSignal,
			);
			if (waitResult.kind === "completed") {
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.stopUpdates();
			autoBgManager.resumeDeliveries([job.jobId]);

			const notices =
				waitResult.kind === "steer"
					? [...pendingNotices, "Backgrounded early to handle an incoming message; the command keeps running."]
					: pendingNotices;
			return this.#buildBackgroundStartResult(job.jobId, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices,
			});
		}

		const backendPreflight =
			(clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) ||
			canUseInteractiveBashPty(pty, ctx)
				? await applyDirenvPreflight(command, commandCwd, {
						callerEnv: resolvedEnv,
						signal,
						timeoutMs: this.session.settings.get("bash.direnvLoadTimeoutMs"),
						callerTimeoutMs: timeoutMs,
						direnvSetting: this.session.settings.get("bash.direnv"),
					})
				: undefined;

		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty && !xdBridge) {
			if (signal?.aborted) {
				throw new ToolAbortError("Command aborted");
			}

			const bridgeWallTimeStart = performance.now();
			const killGraceMs = 1000;
			const outputSnapshotGraceMs = 2000;

			const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<{
				kind: "timeout";
			}>();
			const timeoutTimer = timeoutMs ? setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs) : undefined;
			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let handle: ClientBridgeTerminalHandle | undefined;
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				const currentHandle = handle;
				if (!currentHandle) return Promise.resolve();
				killStarted = true;
				return currentHandle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: currentHandle.terminalId, error });
				});
			};
			const cleanupLateCreate = (createP: Promise<ClientBridgeTerminalHandle>): void => {
				void createP
					.then(async lateHandle => {
						try {
							await lateHandle.kill();
						} catch (error) {
							logger.warn("ACP terminal kill failed", { terminalId: lateHandle.terminalId, error });
						}
						try {
							await lateHandle.release();
						} catch (error) {
							logger.warn("ACP terminal release failed", { terminalId: lateHandle.terminalId, error });
						}
					})
					.catch((error: unknown) => {
						logger.warn("ACP terminal create failed after cancellation", { error });
					});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				const bridgeCommand = backendPreflight?.command ?? command;
				const bridgeEnv = backendPreflight?.env ?? resolvedEnv;
				const shellSpawn = wrapShellLineForClientTerminal(bridgeCommand, this.session.settings.getShellConfig());
				const createP = clientBridge.createTerminal({
					command: shellSpawn.command,
					args: shellSpawn.args,
					cwd: commandCwd,
					env: bridgeEnv
						? Object.entries(bridgeEnv).map(([name, value]) => ({ name, value: value as string }))
						: undefined,
					outputByteLimit: DEFAULT_MAX_BYTES,
				});
				const createRaced = await Promise.race([
					createP.then(createdHandle => ({ kind: "created" as const, handle: createdHandle })),
					timeoutPromise,
					abortedP.then(() => ({ kind: "aborted" as const })),
				]);
				if (createRaced.kind === "aborted" || signal?.aborted) {
					cleanupLateCreate(createP);
					throw new ToolAbortError("Command aborted");
				}
				if (createRaced.kind === "timeout") {
					cleanupLateCreate(createP);
					const timedOutResult: BashInteractiveResult = {
						output: "",
						exitCode: undefined,
						cancelled: false,
						timedOut: true,
						truncated: false,
						totalLines: 0,
						totalBytes: 0,
						outputLines: 0,
						outputBytes: 0,
					};
					this.#throwIfUnfinished(timedOutResult, timeoutSec, this.#formatResultOutput(timedOutResult));
					throw new ToolError("Command timed out");
				}

				handle = createRaced.handle;

				onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

				const exitPromise = handle.waitForExit();
				let exitStatus!: ClientBridgeTerminalExitStatus;

				type BridgeRaceResult =
					| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
					| { kind: "poll" }
					| { kind: "timeout" }
					| { kind: "aborted" };

				const exitRacer = exitPromise.then(status => ({ kind: "exit" as const, status }));
				const abortRacer = abortedP.then(() => ({ kind: "aborted" as const }));
				const abortPollRacer = abortedP.then(() => undefined as ClientBridgeTerminalOutput | undefined);
				const timeoutPollRacer = timeoutPromise.then(() => undefined as ClientBridgeTerminalOutput | undefined);
				let lastPolledOutput: ClientBridgeTerminalOutput = { output: "", truncated: false };

				for (;;) {
					const racers: Array<Promise<BridgeRaceResult>> = [
						exitRacer,
						timeoutPromise,
						Bun.sleep(250).then(() => ({ kind: "poll" as const })),
					];
					if (signal) {
						racers.push(abortRacer);
					}
					const raced = await Promise.race(racers);

					if (raced.kind === "aborted" || signal?.aborted) {
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						throw new ToolAbortError("Command aborted");
					}

					if (raced.kind === "timeout") {
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						let current = lastPolledOutput;
						try {
							current = await Promise.race([
								handle.currentOutput(),
								Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
							]);
						} catch (error) {
							logger.warn("ACP terminal final output read failed", {
								terminalId: handle.terminalId,
								error,
							});
						}
						const timedOutResult: BashInteractiveResult = {
							output: current.output,
							exitCode: undefined,
							cancelled: false,
							timedOut: true,
							truncated: current.truncated,
							totalLines: current.output.length > 0 ? current.output.split("\n").length : 0,
							totalBytes: current.output.length,
							outputLines: current.output.length > 0 ? current.output.split("\n").length : 0,
							outputBytes: current.output.length,
						};
						this.#throwIfUnfinished(timedOutResult, timeoutSec, this.#formatResultOutput(timedOutResult));
						throw new ToolError("Command timed out");
					}

					if (raced.kind === "exit") {
						exitStatus = raced.status;
						break;
					}

					const pollOutput = await Promise.race([handle.currentOutput(), abortPollRacer, timeoutPollRacer]);
					if (pollOutput === undefined) {
						continue;
					}
					lastPolledOutput = pollOutput;
					onUpdate?.({
						content: [{ type: "text", text: pollOutput.output }],
						details: {
							terminalId: handle.terminalId,
							execution: {
								state: "running",
								collector: { state: "running" },
								renderer: { state: "not-run" },
								output: { disposition: "complete" },
							},
						},
					});
				}

				let finalOutput = lastPolledOutput;
				try {
					finalOutput = await Promise.race([
						handle.currentOutput(),
						Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
					]);
				} catch (error) {
					logger.warn("ACP terminal final output read failed", {
						terminalId: handle.terminalId,
						error,
					});
				}

				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const outputText = finalOutput.output;
				const outputByteLen = outputText.length;
				const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;

				const bridgeResult: BashResult = {
					output: outputText,
					exitCode,
					cancelled: false,
					truncated: finalOutput.truncated,
					totalLines: outputLineCount,
					totalBytes: outputByteLen,
					outputLines: outputLineCount,
					outputBytes: outputByteLen,
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					requestedTimeoutSec,
					notices: bridgeNotices,
					terminalId: handle.terminalId,
					wallTimeMs: performance.now() - bridgeWallTimeStart,
				});
			} finally {
				clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onAbortSignal);
				if (handle) {
					const releaseHandle = handle;

					await Promise.race([
						releaseHandle.release().catch((error: unknown) => {
							logger.warn("ACP terminal release failed", { terminalId: releaseHandle.terminalId, error });
						}),
						Bun.sleep(killGraceMs),
					]);
				}
			}
		}

		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("bash")) ?? {};

		const interactiveUi = canUseInteractiveBashPty(pty, ctx) ? ctx?.ui : undefined;
		if (pty && !interactiveUi) {
			pendingNotices.push("pty requested but unavailable in this environment; ran without a terminal");
		}
		const wallTimeStart = performance.now();
		// Stream kernel-cell status events (write/edit hunks) into the live view
		// so a running `python`/`node`/`bun` cell shows its Status section like an eval
		// cell — hunks render as soon as their event is delivered, tail-truncated
		// to the live window (see eval-render's EVAL_STREAMING_SECTION_LINES).
		const liveStatusEvents: EvalStatusEvent[] = [];
		const pushLiveUpdate = (): void => {
			onUpdate?.({
				content: [{ type: "text", text: tailBuffer.text() }],
				details: {
					execution: {
						state: "running",
						collector: { state: "running" },
						renderer: { state: "not-run" },
						output: { disposition: "complete" },
					},
					...(liveStatusEvents.length > 0 ? { statusEvents: [...liveStatusEvents] } : {}),
				},
			});
		};
		const pyBridge = interactiveUi
			? undefined
			: this.#kernelShellBridge(
					_toolCallId,
					{ command: rawCommand, cwd, env: rawEnv, pty, async: asyncRequested },
					event => {
						liveStatusEvents.push(event);
						pushLiveUpdate();
					},
				);
		let result: BashResult | BashInteractiveResult;
		try {
			result = interactiveUi
				? await runInteractiveBashPty(interactiveUi, {
						command: backendPreflight?.command ?? command,
						cwd: commandCwd,
						timeoutMs,
						signal,
						env: backendPreflight?.env ?? resolvedEnv,
						artifactPath,
						artifactId,
					})
				: await executeBash(command, {
						cwd: commandCwd,
						sessionKey: this.session.getSessionId?.() ?? undefined,
						timeout: timeoutMs ?? 0,
						signal,
						env: pyBridge ? { ...resolvedEnv, ...pyBridge.env } : resolvedEnv,
						xd: xdBridge,
						artifactPath,
						artifactId,
						onChunk: chunk => {
							tailBuffer.append(chunk);
							pushLiveUpdate();
						},
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
		} catch (error) {
			pyBridge?.dispose();
			throw error;
		}
		this.#recordFsObservations(result);
		const wallTimeMs = performance.now() - wallTimeStart;
		if (result.cancelled) {
			const isTimeout = result.timedOut === true;
			if (!isTimeout) {
				const out = normalizeResultOutput(result);

				const message = out.startsWith("[Command cancelled]")
					? out
					: out
						? `${out}\n\n[Command aborted]`
						: "Command aborted";
				if (signal?.aborted) {
					throw new ToolAbortError(message);
				}
				throw new ToolError(message);
			}
		}
		try {
			return await this.#buildCompletedResult(result, timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
				wallTimeMs,
				images: await this.#drainBridgeImages(pyBridge),
				statusEvents: pyBridge?.drainStatusEvents(),
				jsonOutputs: pyBridge?.drainJsonOutputs(),
			});
		} finally {
			pyBridge?.dispose();
		}
	}
}

interface BashRenderArgs {
	command?: string;
	env?: Record<string, unknown>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

interface BashRenderContext {
	output?: string;

	isFullOutput?: boolean;

	expanded?: boolean;

	previewLines?: number;

	timeout?: number;
}

interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, unknown> | undefined;
	showHeader?: boolean;
}

function getPartialJson<TArgs>(args: TArgs | undefined): string | undefined {
	if (!args || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = (args as { __partialJson?: unknown }).__partialJson;
	return typeof value === "string" ? value : undefined;
}

function getBashEnvForDisplay(args: BashRenderArgs): Record<string, unknown> | undefined {
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

function formatBashCommandLines(args: BashRenderArgs, uiTheme: Theme): string[] {
	const command = replaceTabs(args.command || "…");
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(command, "bash");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	return highlightedLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

// A kernel-routed `python`/`node`/`bun` bash cell renders identically to an `eval`
// cell (header, AST preview, output, Status hunks, JSON display trees) by
// building an EvalCellResult and handing it to the shared renderKernelCellLines.
function kernelCellLines(
	kernelCell: BashKernelCell,
	uiTheme: Theme,
	opts: {
		output: string;
		status: "running" | "complete" | "error";
		details: BashToolDetails | undefined;
		expanded: boolean;
		isPartial: boolean;
		spinnerFrame?: number;
		previewLines: number;
		width: number;
	},
): string[] {
	const cell: EvalCellResult = {
		index: 0,
		code: kernelCell.code,
		language: kernelCell.language === "js" ? "js" : "python",
		output: opts.output,
		status: opts.status,
		statusEvents: opts.details?.statusEvents,
		durationMs: opts.details?.wallTimeMs !== undefined ? Math.round(opts.details.wallTimeMs) : undefined,
		execution: opts.details?.execution ? { ...opts.details.execution, renderer: { state: "complete" } } : undefined,
	};
	return renderKernelCellLines(cell, opts.details?.jsonOutputs ?? [], uiTheme, {
		expanded: opts.expanded,
		isPartial: opts.isPartial,
		spinnerFrame: opts.spinnerFrame,
		previewLines: opts.previewLines,
		width: opts.width,
	});
}

function toBashRenderArgs<TArgs>(args: TArgs | undefined, config: ShellRendererConfig<TArgs>): BashRenderArgs {
	return {
		command: config.resolveCommand?.(args),
		cwd: config.resolveCwd?.(args),
		env: config.resolveEnv?.(args),
		__partialJson: getPartialJson(args),
	};
}

export function createShellRenderer<TArgs>(config: ShellRendererConfig<TArgs>) {
	// Kernel-routed `python`/`node`/`bun` cells animate their preview while running,
	// matching the eval tool (plain shell commands keep the default behavior).
	const isKernelCellArgs = (args: unknown): boolean => {
		const command = config.resolveCommand?.(args as TArgs);
		return typeof command === "string" && detectBashKernelCell(command) !== undefined;
	};
	return {
		animatedPendingPreview: isKernelCellArgs,
		animatedPartialResult: isKernelCellArgs,
		renderCall(args: TArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const kernelCell = renderArgs.command ? detectBashKernelCell(renderArgs.command) : undefined;
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					if (kernelCell) {
						return kernelCellLines(kernelCell, uiTheme, {
							output: "",
							status: "running",
							details: undefined,
							expanded: options.expanded === true,
							isPartial: true,
							spinnerFrame: options.spinnerFrame,
							previewLines: EVAL_DEFAULT_PREVIEW_LINES,
							width,
						});
					}
					const cmdLines = formatBashCommandLines(renderArgs, uiTheme);
					const header =
						config.showHeader === false
							? undefined
							: renderStatusLine(
									{
										icon: options.spinnerFrame !== undefined ? "running" : "pending",
										spinnerFrame: options.spinnerFrame,
										title: config.resolveTitle(args, options),
									},
									uiTheme,
								);
					return outputBlock.render(
						{
							header,
							state: options.spinnerFrame !== undefined ? "running" : "pending",
							sections: [{ lines: capPreviewLines(cmdLines, uiTheme, { expanded: options.expanded }) }],
							width,
						},
						uiTheme,
					);
				},
				invalidate: () => {
					outputBlock.invalidate();
				},
			});
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions & { renderContext?: BashRenderContext },
			uiTheme: Theme,
			args?: TArgs,
		): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const kernelCell = renderArgs.command ? detectBashKernelCell(renderArgs.command) : undefined;
			const details = result.details;
			const execution = details?.execution;
			const isPartial = options.isPartial === true;
			const isError = execution
				? execution.state === "exited" && execution.exitCode !== undefined && execution.exitCode !== 0
				: result.isError === true;
			const isUnknown = execution
				? execution.state === "unknown" || (execution.state === "exited" && execution.exitCode === undefined)
				: false;
			const success =
				!isPartial && (execution ? execution.state === "exited" && execution.exitCode === 0 : !isError);
			const isTimeout = details?.timedOut === true || execution?.timeout !== undefined;
			const warningStatus = isTimeout || isUnknown;
			const header =
				config.showHeader === false
					? success || isPartial
						? undefined
						: renderStatusLine(
								{
									icon: warningStatus ? "warning" : "error",
									title: warningStatus ? "status unknown" : "failed",
									titleColor: warningStatus ? "warning" : "error",
								},
								uiTheme,
							)
					: renderStatusLine(
							success
								? {
										iconOverride: uiTheme.styledSymbol("tool.bash", "accent"),
										title: config.resolveTitle(args, options),
									}
								: {
										icon: isPartial ? "pending" : warningStatus ? "warning" : "error",
										title: config.resolveTitle(args, options),
									},
							uiTheme,
						);
			const outputBlock = new CachedOutputBlock();

			let cachedWidth: number | undefined;
			let cachedPreviewLines: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedRawOutput: string | undefined;
			let cachedIsPartial: boolean | undefined;
			let cachedLines: readonly string[] | undefined;
			let cachedPreviewWindow: number | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					const rawOutput = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";

					const isPartial = options.isPartial === true;
					const previewWindow = previewWindowRows();

					if (
						cachedLines !== undefined &&
						cachedWidth === width &&
						cachedPreviewLines === previewLines &&
						cachedExpanded === expanded &&
						cachedRawOutput === rawOutput &&
						cachedIsPartial === isPartial &&
						cachedPreviewWindow === previewWindow
					) {
						return cachedLines;
					}
					const withoutBackground = stripBackgroundNotice(rawOutput, details?.async);
					const strippedOutput = stripOutputNotice(withoutBackground, details?.meta);
					const withoutExit = stripExitCodeNotice(strippedOutput, details?.exitCode);
					const withoutWall = stripWallTimeNotice(withoutExit, details?.wallTimeMs);
					const rawOutputArtifact = stripRawOutputArtifactNotice(withoutWall);
					const output = rawOutputArtifact.text;
					const displayOutput = output.trimEnd();

					if (kernelCell) {
						const lines = kernelCellLines(kernelCell, uiTheme, {
							output: displayOutput,
							status: isPartial ? "running" : isError ? "error" : "complete",
							details,
							expanded,
							isPartial,
							spinnerFrame: options.spinnerFrame,
							previewLines: EVAL_DEFAULT_PREVIEW_LINES,
							width,
						});
						cachedWidth = width;
						cachedPreviewLines = previewLines;
						cachedExpanded = expanded;
						cachedRawOutput = rawOutput;
						cachedIsPartial = isPartial;
						cachedPreviewWindow = previewWindow;
						cachedLines = lines;
						return lines;
					}

					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					const timeoutDisabled = details?.timeoutDisabled === true || renderContext?.timeout === 0;
					const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? renderContext?.timeout);
					const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
					const wallTimeMs = details?.wallTimeMs;
					const statsParts: string[] = [];
					if (details?.async?.state === "running") {
						statsParts.push(`Backgrounded: ${details.async.jobId}`);
					}
					if (wallTimeMs !== undefined) {
						statsParts.push(`Wall: ${formatWallTimeSeconds(wallTimeMs)}s`);
					}
					if (timeoutDisabled) {
						statsParts.push("Timeout: disabled");
					}
					if (typeof timeoutSeconds === "number") {
						statsParts.push(
							requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
								? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
								: `Timeout: ${timeoutSeconds}s`,
						);
					}
					if (rawOutputArtifact.artifactId) {
						statsParts.push(`Artifact: ${rawOutputArtifact.artifactId}`);
					}
					if (isError && typeof details?.exitCode === "number") {
						statsParts.push(`Exit: ${details.exitCode}`);
					}
					const timeoutLine =
						statsParts.length > 0
							? uiTheme.fg(
									"dim",
									`${uiTheme.format.bracketLeft}${statsParts.join(" | ")}${uiTheme.format.bracketRight}`,
								)
							: undefined;
					let warningLine: string | undefined;
					if (details?.meta?.truncation && !showingFullOutput) {
						warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
					}

					const outputLines: string[] = [];
					const executionLine = formatExecutionMetadata(
						execution ? { ...execution, renderer: { state: "complete" } } : undefined,
					);
					if (executionLine) outputLines.push(uiTheme.fg("dim", executionLine));
					const hasOutput = displayOutput.trim().length > 0;
					const rawOutputLines = displayOutput.split("\n");
					const sixelLineMask =
						TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(rawOutputLines) : undefined;
					const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
					if (hasOutput) {
						if (hasSixelOutput) {
							outputLines.push(
								...rawOutputLines.map((line, index) =>
									sixelLineMask?.[index] ? line : uiTheme.fg("toolOutput", replaceTabs(line)),
								),
							);
						} else if (expanded) {
							outputLines.push(...rawOutputLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
						} else {
							const styledOutput = rawOutputLines
								.map(line => uiTheme.fg("toolOutput", replaceTabs(line)))
								.join("\n");
							const textContent = styledOutput;

							const previewBudget = Math.min(previewLines, previewWindow);
							const result = truncateToVisualLines(textContent, previewBudget, outputBlockContentWidth(width));
							if (result.skippedCount > 0) {
								const expandHint = expandKeyHint().toLowerCase();
								outputLines.push(
									uiTheme.fg(
										"dim",
										`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length})${expandHint ? ` (${expandHint} to expand)` : ""}`,
									),
								);
							}
							outputLines.push(...result.visualLines);
						}
					}
					if (timeoutLine) outputLines.push(timeoutLine);
					if (warningLine) outputLines.push(warningLine);

					const cmdLines = args ? formatBashCommandLines(renderArgs, uiTheme) : undefined;
					const framed = outputBlock.render(
						{
							header,
							state: isPartial ? "pending" : isError ? (isTimeout ? "warning" : "error") : "success",
							sections: [
								{
									lines: capPreviewLines(cmdLines ?? [], uiTheme, { expanded }),
								},
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
						},
						uiTheme,
					);

					cachedWidth = width;
					cachedPreviewLines = previewLines;
					cachedExpanded = expanded;
					cachedRawOutput = rawOutput;
					cachedIsPartial = isPartial;
					cachedPreviewWindow = previewWindow;
					cachedLines = framed;
					return framed;
				},
				invalidate: () => {
					outputBlock.invalidate();
					cachedLines = undefined;
					cachedWidth = undefined;
					cachedPreviewLines = undefined;
					cachedExpanded = undefined;
					cachedRawOutput = undefined;
					cachedIsPartial = undefined;
					cachedPreviewWindow = undefined;
				},
			});
		},
		mergeCallAndResult: true,
		inline: true,
	};
}

export const bashToolRenderer = createShellRenderer<BashRenderArgs>({
	resolveTitle: () => "Bash",
	resolveCommand: args => args?.command,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
	showHeader: false,
});
