import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { type Tool as AiTool, jsonSchemaToTypeScript, toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { schemaDefinesProperty } from "@oh-my-pi/pi-ai/utils/schema";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { Container } from "@oh-my-pi/pi-tui/tui";
import { INTENT_FIELD, isRecord, parseStreamingJson, sanitizeText, truncateHeadBytes } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { extractUriScheme } from "../internal-urls/parse";
import { PROTOLENS_URL_PREFIX } from "../internal-urls/protolens-protocol";
import { parseMCPToolName } from "../mcp/tool-bridge";
import type { Theme } from "../modes/theme/theme";
import type { ExecutionStageMetadata } from "../session/execution-metadata";
import { renderStatusLine } from "../tui/status-line";
import { getTreeBranch } from "../tui/utils";
import { WidthAwareText } from "../tui/width-aware-text";
import type { Tool, ToolSession } from "./index";
import { isReadableUrlPath, resolveToCwd, splitPathAndSel } from "./path-utils";
import {
	formatExpandHint,
	PREVIEW_LIMITS,
	pluralize,
	replaceTabs,
	type ToolUIColor,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import type { ToolRenderer } from "./renderers";
import { dispatchReportIssueDevice, REPORT_ISSUE_DEVICE_NAME } from "./report-tool-issue";
import { dispatchResolutionDevice, isResolutionDeviceName } from "./resolve";
import { tokenizeShellSegments } from "./shell-tokenize";
import { renderError, ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import {
	formatCliFlagReference,
	formatCliUsageSynopsis,
	formatXdevCliFlags,
	parseXdevCliArgs,
	quoteShellValue,
	type XdevCliParseOptions,
	xdevFlagSpecs,
} from "./xdev-cli";

/**
 * Tool names that always stay top-level native tools, even if something declares them
 * discoverable — mirrors ESSENTIAL_BUILTIN_TOOL_NAMES minus the bash transport.
 */
export const XDEV_KEEP_TOP_LEVEL: Record<string, true> = {
	read: true,
	ask: true,
	checklist: true,
	web_search: true,
};

const XDEV_TRANSPORT_TOOLS: Record<string, true> = { bash: true };

type XdevDocsMode = "inline" | "builtins" | "catalog";

export function isMountableUnderXdev(tool: { name: string; loadMode?: ToolLoadMode }): boolean {
	if (tool.name in XDEV_TRANSPORT_TOOLS || tool.name in XDEV_KEEP_TOP_LEVEL) return false;
	return tool.loadMode === "discoverable";
}

export interface XdevDispatch {
	/** Device name; empty for the device listing (`protolens` with no device). */
	tool: string;
	mode: "help" | "execute" | "listing";

	args?: Record<string, unknown>;

	/** Original shell argv when dispatched via the CLI form (`protolens browser --action run`). */
	argv?: string[];

	inner?: unknown;

	/** Set by the bash transport when this dispatch failed; drives the error icon on its card. */
	isError?: boolean;

	/** Mounted devices shown by the listing. */
	devices?: ReadonlyArray<{ name: string; summary: string }>;
}

let rendererLookup: ((name: string) => ToolRenderer | undefined) | undefined;

export function setXdevRendererLookup(lookup: (name: string) => ToolRenderer | undefined): void {
	rendererLookup = lookup;
}

interface RenderedDocs {
	prose: string;
	schema: string;
	footer: string;
}

/** MCP devices take only a JSON args object; their schemas are not CLI-mappable. */
function isJsonOnlyDevice(name: string): boolean {
	return parseMCPToolName(name) !== null;
}

function renderDocsParts(
	inst: Tool,
	heading = "#",
	descriptionCap?: number,
	cliDetail: "synopsis" | "reference" = "synopsis",
): RenderedDocs {
	const wireSchema = toolWireSchema(inst as AiTool);
	const schema = jsonSchemaToTypeScript(wireSchema);
	let description = inst.description ?? "";
	if (descriptionCap !== undefined && description.length > descriptionCap) {
		description = `${description.slice(0, descriptionCap).trimEnd()}… (full docs: \`protolens ${inst.name} ?\`)`;
	}
	const usageOptions = { jsonOnly: isJsonOnlyDevice(inst.name) };
	const usage =
		cliDetail === "reference"
			? formatCliFlagReference(inst.name, inst as AiTool, usageOptions)
			: `usage: ${formatCliUsageSynopsis(inst.name, wireSchema, usageOptions)}`;
	return {
		prose: [`${heading} ${inst.name}${inst.label ? ` — ${inst.label}` : ""}`, "", description].join("\n"),
		schema: [`${heading}# Schema`, "```ts", `type Args = ${schema};`, "```"].join("\n"),
		footer: (usageOptions.jsonOnly
			? [
					usage,
					"",
					`Execute from bash with one JSON args object: \`protolens ${inst.name} --json '<json>'\`, \`protolens ${inst.name} '<json>'\`, or JSON piped on stdin (\`protolens ${inst.name} ?\` for these docs). Flags and positional values are rejected.`,
				]
			: [
					usage,
					"",
					`Execute from bash with the flags/positionals above (or \`protolens ${inst.name} ?\` for these docs).`,
					`JSON escape hatch: \`protolens ${inst.name} --json '<json>'\`, or pipe a JSON args object on stdin; a \`-\` flag value reads stdin. MCP devices accept JSON only.`,
				]
		).join("\n"),
	};
}

function renderDocs(inst: Tool, heading = "#", descriptionCap?: number, cliDetail?: "synopsis" | "reference"): string {
	const parts = renderDocsParts(inst, heading, descriptionCap, cliDetail);
	return [parts.prose, parts.schema, parts.footer].join("\n\n");
}

function schemaProperties(schema: Record<string, unknown>): string[] | undefined {
	// JSON Schema objects are open by default; only an explicit false closes the key set.
	if (schema.additionalProperties !== false) return undefined;
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
	return Object.keys(properties as Record<string, unknown>);
}

function unknownProtoKeys(args: Record<string, unknown>, schema: Record<string, unknown>): string[] {
	const accepted = schemaProperties(schema);
	if (!accepted) return [];
	const declared = new Set(accepted);
	return Object.keys(args).filter(key => !declared.has(key));
}

import { suggestKnownKey } from "./xdev-cli";

function validateProtoArgs(
	device: Tool,
	rawArgs: Record<string, unknown>,
	toolCallId: string,
	schema: Record<string, unknown>,
	validationDocs: () => string,
): Record<string, unknown> {
	let args = rawArgs;
	if (INTENT_FIELD in args && !schemaDefinesProperty(schema, INTENT_FIELD)) {
		// Published tool schemas carry the intent field; devices that do not
		// declare it accept and drop it instead of rejecting the whole call.
		args = { ...args };
		delete args[INTENT_FIELD];
	}
	const unknown = unknownProtoKeys(args, schema);
	if (unknown.length > 0) {
		const accepted = schemaProperties(schema) ?? [];
		const acceptedText = accepted.length > 0 ? accepted.join(", ") : "(none — this device takes no parameters)";
		const hints = unknown
			.map(key => suggestKnownKey(key, accepted))
			.filter((hint): hint is string => hint !== undefined)
			.map(hint => `did you mean \`${hint}\`?`);
		const hintText = hints.length > 0 ? ` ${hints.join(" ")}` : "";
		throw new ToolError(
			`Invalid args for ${PROTOLENS_URL_PREFIX}${device.name}: unknown top-level key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.${hintText} Accepted keys: ${acceptedText}.`,
		);
	}
	try {
		return validateToolArguments(device as AiTool, {
			type: "toolCall",
			id: toolCallId,
			name: device.name,
			arguments: args,
		});
	} catch (error) {
		// Same contract as the agent loop: a lenient tool owns its refusal/repair of mismatched args (malformed JSON
		// and unknown keys still throw above). The sentinels are stripped so a payload cannot forge a parse failure.
		if (device.lenientArgValidation) {
			const fallback = { ...args };
			delete fallback.__parseError;
			delete fallback.__rawJson;
			return fallback;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Invalid args for ${PROTOLENS_URL_PREFIX}${device.name}: ${message}\n\n${validationDocs()}`);
	}
}

function parseDeviceArgs(device: Tool, content: string, toolCallId: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new ToolError(
			`${PROTOLENS_URL_PREFIX}${device.name} expects a JSON args object as content (${error instanceof Error ? error.message : String(error)}). Write \`?\` for docs.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ToolError(
			`${PROTOLENS_URL_PREFIX}${device.name} content must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
		);
	}

	const args: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	const schema = toolWireSchema(device as AiTool);
	return validateProtoArgs(device, args, toolCallId, schema, () => renderDocsParts(device).schema);
}

function toolSummary(inst: Tool): string {
	if (inst.summary) return inst.summary;
	const firstLine = (inst.description ?? "").split("\n").find(line => line.trim().length > 0);
	return firstLine?.trim() ?? inst.label ?? inst.name;
}

const SUMMARY_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const SUMMARY_ELLIPSIS = "…";
const SUMMARY_ELLIPSIS_BYTES = Buffer.byteLength(SUMMARY_ELLIPSIS, "utf-8");

function sanitizeCatalogSummary(summary: string, maxBytes?: number): string {
	const cleaned = summary.replace(SUMMARY_CONTROL_CHARS, " ").trim();
	if (maxBytes === undefined || Buffer.byteLength(cleaned, "utf-8") <= maxBytes) return cleaned;
	if (maxBytes <= 0) return "";
	if (maxBytes < SUMMARY_ELLIPSIS_BYTES) return truncateHeadBytes(cleaned, maxBytes).text;
	const body = truncateHeadBytes(cleaned, maxBytes - SUMMARY_ELLIPSIS_BYTES).text.trimEnd();
	return `${body}${SUMMARY_ELLIPSIS}`;
}

function promptCatalogSummary(inst: Tool, maxBytes?: number): string {
	const summary =
		toolSummary(inst)
			.split("\n")
			.find(line => line.trim().length > 0)
			?.trim() ?? inst.name;
	return sanitizeCatalogSummary(summary, maxBytes) || inst.name;
}

function compileInlineGlobs(patterns: readonly string[]): Bun.Glob[] {
	if (!Array.isArray(patterns)) return [];
	const globs: Bun.Glob[] = [];
	for (const pattern of patterns) {
		if (typeof pattern !== "string" || pattern.length === 0) continue;
		globs.push(new Bun.Glob(pattern));
	}
	return globs;
}

function decodeInnerArgs(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "string" || raw.length === 0) return {};
	const parsed = parseStreamingJson<Record<string, unknown>>(raw);
	const args: Record<string, unknown> = parsed && typeof parsed === "object" ? { ...parsed } : {};
	args.__partialJson = raw;
	return args;
}

const HELP_CONTENT_RE = /^\s*(\?|help)?\s*$/i;

export interface XdevState {
	readonly tools: Map<string, Tool>;

	readonly mountedNames: Set<string>;

	readonly builtInNames: Set<string>;

	readonly isActive: (name: string) => boolean;
}

export const XDEV_DOCS_TOTAL_BUDGET = 48_000;

export const XDEV_DOCS_PER_DEVICE_CAP = 10_000;

export const XDEV_EXTERNAL_DESCRIPTION_CAP = 200;

/** Resolve a dispatchable device: a mounted device or an active top-level tool. */
export function resolveXdevTool(state: XdevState, name: string): Tool | undefined {
	if (name in XDEV_TRANSPORT_TOOLS) return undefined;
	if (!state.mountedNames.has(name) && !state.isActive(name)) return undefined;
	return state.tools.get(name);
}

/** Resolve a mounted device by bare name or by the `protolens://name` spelling its docs advertise. */
export function resolveMountedXdevTool(state: XdevState, name: string): Tool | undefined {
	const bare = name.startsWith(PROTOLENS_URL_PREFIX) ? name.slice(PROTOLENS_URL_PREFIX.length) : name;
	return state.mountedNames.has(bare) ? state.tools.get(bare) : undefined;
}

export function resolveMountedXdevExecutable(state: XdevState, name: string): Tool | undefined {
	const tool = resolveMountedXdevTool(state, name);
	return tool;
}

export function listXdevTools(state: XdevState): Tool[] {
	return [...state.mountedNames].flatMap(name => {
		const tool = state.tools.get(name);
		return tool ? [tool] : [];
	});
}

export function xdevEntries(state: XdevState): Array<{ name: string; summary: string; dynamic: boolean }> {
	return listXdevTools(state).map(tool => {
		const dynamic = !state.builtInNames.has(tool.name);
		return {
			name: tool.name,
			summary: promptCatalogSummary(tool, dynamic ? XDEV_EXTERNAL_DESCRIPTION_CAP : undefined),
			dynamic,
		};
	});
}

export function xdevListing(state: XdevState): string {
	const rows = xdevEntries(state).map(({ name, summary }) => `${PROTOLENS_URL_PREFIX}${name.padEnd(14)} ${summary}`);
	return [
		`${PROTOLENS_URL_PREFIX} ${state.mountedNames.size} mounted tool devices.`,
		...rows,
		"",
		`Docs + CLI usage: run \`protolens <tool> ?\` in bash; execute with \`protolens <tool> [flags]\` or \`protolens <tool> --json '<json>'\`. Active top-level tools accept the same dispatch.`,
	].join("\n");
}

export function xdevDocs(state: XdevState, name: string): string {
	return renderDocs(resolveRequiredXdevTool(state, name), "#", undefined, "reference");
}

/** Mounted-device placement in the system prompt: inlined docs sections, then one-line catalog entries. */
export interface XdevPromptDocs {
	readonly sections: readonly string[];
	/** Catalog summary per device listed as a one-line entry, in presentation order. */
	readonly catalog: ReadonlyMap<string, string>;
}

/** Places mounted devices under the prompt-doc policy and budgets; a device not inlined (or over a cap) is a catalog entry. */
export function planXdevPromptDocs(
	state: XdevState,
	mode: XdevDocsMode = "catalog",
	inlinePatterns: readonly string[] = [],
): XdevPromptDocs {
	const sections: string[] = [];
	const catalog = new Map<string, string>();
	const inlineGlobs = compileInlineGlobs(inlinePatterns);
	let used = 0;
	for (const tool of listXdevTools(state)) {
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		if (shouldInlineXdevTool(state, tool, mode, inlineGlobs)) {
			const docs = renderDocs(tool, "##", descriptionCap);
			if (docs.length <= XDEV_DOCS_PER_DEVICE_CAP && used + docs.length <= XDEV_DOCS_TOTAL_BUDGET) {
				used += docs.length;
				sections.push(docs);
				continue;
			}
		}
		catalog.set(tool.name, promptCatalogSummary(tool, descriptionCap));
	}
	return { sections, catalog };
}

/** Renders planned prompt docs; devices in `listedElsewhere` get no catalog line (the caller lists them with their summary). */
export function renderXdevPromptDocs(docs: XdevPromptDocs, listedElsewhere?: ReadonlySet<string>): string {
	const lines: string[] = [];
	for (const [name, summary] of docs.catalog) {
		if (!listedElsewhere?.has(name)) lines.push(`- ${PROTOLENS_URL_PREFIX}${name} — ${summary}`);
	}
	if (lines.length === 0) return docs.sections.join("\n\n");
	return [...docs.sections, ["## Additional devices (docs on demand)", ...lines].join("\n")].join("\n\n");
}

export function xdevDocsAll(
	state: XdevState,
	mode: XdevDocsMode = "catalog",
	inlinePatterns: readonly string[] = [],
): string {
	return renderXdevPromptDocs(planXdevPromptDocs(state, mode, inlinePatterns));
}

export function xdevDocsFor(
	state: XdevState,
	names: Iterable<string>,
	mode: XdevDocsMode,
	inlinePatterns: readonly string[] = [],
): string {
	const sections: string[] = [];
	const inlineGlobs = compileInlineGlobs(inlinePatterns);
	let used = 0;
	for (const name of names) {
		const tool = resolveMountedXdevTool(state, name);
		if (!tool || !shouldInlineXdevTool(state, tool, mode, inlineGlobs)) continue;
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		const docs = renderDocs(tool, "##", descriptionCap);
		if (docs.length > XDEV_DOCS_PER_DEVICE_CAP || used + docs.length > XDEV_DOCS_TOTAL_BUDGET) continue;
		used += docs.length;
		sections.push(docs);
	}
	return sections.join("\n\n");
}

function shouldInlineXdevTool(
	state: XdevState,
	tool: Tool,
	mode: XdevDocsMode,
	inlineGlobs: readonly Bun.Glob[],
): boolean {
	return (
		mode !== "catalog" &&
		(mode === "inline" || state.builtInNames.has(tool.name) || inlineGlobs.some(glob => glob.match(tool.name)))
	);
}

function resolveRequiredXdevTool(state: XdevState, name: string): Tool {
	const inst = resolveXdevTool(state, name);
	if (!inst) {
		throw new ToolError(
			`No such tool: ${PROTOLENS_URL_PREFIX}${name}. Mounted devices: ${[...state.mountedNames].join(", ")}. Active top-level tools are also dispatchable via ${PROTOLENS_URL_PREFIX}<tool>.`,
		);
	}
	return inst;
}

/** Scope a `read` device args object to the dispatching shell's working directory. */
function scopeXdevReadArgs(args: Record<string, unknown>, cwd: string): void {
	if (typeof args.path !== "string" || extractUriScheme(args.path) !== undefined) return;
	const split = splitPathAndSel(args.path);
	const resolved = isReadableUrlPath(split.path) ? split.path : resolveToCwd(split.path, cwd);
	args.path = split.sel ? `${resolved}:${split.sel}` : resolved;
}

interface XdevExecuteOptions {
	toolCallId: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	context?: AgentToolContext;
	/** Original CLI argv, carried on the dispatch record for TUI previews. */
	argv?: readonly string[];
}

async function executeResolvedXdev(
	name: string,
	canonical: Tool,
	args: Record<string, unknown>,
	options: XdevExecuteOptions,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	const { toolCallId, signal, onUpdate, context } = options;
	let xdev: XdevDispatch = {
		tool: name,
		mode: "execute",
		...(options.argv && options.argv.length > 0 ? { argv: [...options.argv] } : {}),
	};
	try {
		throwIfAborted(signal);
		const validated = validateProtoArgs(
			canonical,
			args,
			toolCallId,
			toolWireSchema(canonical as AiTool),
			() => renderDocsParts(canonical).schema,
		);
		throwIfAborted(signal);
		xdev = { ...xdev, args: validated };
		const innerOnUpdate: AgentToolUpdateCallback | undefined = onUpdate
			? partial =>
					onUpdate({
						content: partial.content,
						details: { xdev: { ...xdev, inner: partial.details } },
						isError: partial.isError,
					})
			: undefined;
		const result = await canonical.execute(toolCallId, validated as never, signal, innerOnUpdate, context);
		return { result, xdev: { ...xdev, inner: result.details } };
	} catch (error) {
		if (
			error instanceof ToolAbortError ||
			signal?.aborted ||
			(error instanceof Error && error.name === "AbortError")
		) {
			throw error;
		}
		return {
			result: {
				content: [{ type: "text", text: renderError(error) }],
				isError: true,
			},
			xdev,
		};
	}
}

export async function dispatchXdevTool(
	state: XdevState,
	name: string,
	content: string,
	toolCallId: string,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback,
	context?: AgentToolContext,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	const canonical = resolveRequiredXdevTool(state, name);
	if (HELP_CONTENT_RE.test(content)) {
		return {
			result: { content: [{ type: "text", text: renderDocs(canonical) }] },
			xdev: { tool: name, mode: "help" },
		};
	}
	const validated = parseDeviceArgs(canonical, content, toolCallId);
	return executeResolvedXdev(name, canonical, validated, { toolCallId, signal, onUpdate, context });
}

export type ProtolensBashDispatch =
	| { kind: "listing" }
	| {
			kind: "device";
			name: string;
			argv: string[];
			stdin?: string;
			stdinTruncated?: boolean;
	  };

export function parseProtolensBashCommand(argv: readonly string[]): ProtolensBashDispatch | undefined {
	if (argv.length === 0 || argv[0] !== "protolens") return undefined;
	const rest = argv.slice(1);
	if (rest.length === 0 || (rest.length === 1 && isHelpArgv(rest))) return { kind: "listing" };
	const [name, ...args] = rest;
	return { kind: "device", name, argv: args };
}

export interface ProtolensDispatchOptions {
	toolCallId: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	context?: AgentToolContext;
	cwd?: string;
}

/** `protolens <tool> ?` / `help` / `--help` variants request the docs card. */
function isHelpArgv(argv: readonly string[]): boolean {
	return argv.length > 0 && /^(?:\?|help|--help|-h)$/i.test(argv[0]);
}

/**
 * Dispatch a `protolens` invocation from the shell bridge: raw argv + captured stdin.
 * CLI flags are mapped through the device wire schema; JSON payloads (single `{...}`
 * positional, `--json`, bare stdin) stay first-class. XdevUsageError propagates so the
 * bridge can exit 2 (usage) instead of 1 (tool failure).
 */
export async function dispatchProtolensArgv(
	session: ToolSession,
	name: string | undefined,
	argv: readonly string[],
	stdin: string | undefined,
	stdinTruncated: boolean | undefined,
	options: ProtolensDispatchOptions,
): Promise<AgentToolResult<unknown>> {
	const textContent = argv.join(" ");
	if (name === REPORT_ISSUE_DEVICE_NAME) {
		const { result, xdev } = await dispatchReportIssueDevice(session, textContent);
		return { ...result, details: { xdev } };
	}
	if (name !== undefined && isResolutionDeviceName(name)) {
		const { result, xdev } = await dispatchResolutionDevice(session, name, textContent, options.signal);
		return { ...result, details: { xdev } };
	}
	const xdev = session.xdev;
	if (!xdev) {
		throw new ToolError("protolens:// is not mounted in this session.");
	}
	if (!name) {
		throw new ToolError(`Cannot dispatch to ${PROTOLENS_URL_PREFIX} itself — pick a device:\n${xdevListing(xdev)}`);
	}
	const canonical = resolveRequiredXdevTool(xdev, name);

	if (isHelpArgv(argv)) {
		return {
			content: [{ type: "text", text: renderDocs(canonical) }],
			details: { xdev: { tool: name, mode: "help" } },
		};
	}

	const parseOptions: XdevCliParseOptions = {
		deviceName: name,
		stdin,
		stdinTruncated,
		jsonOnly: isJsonOnlyDevice(name),
	};
	const parsed = parseXdevCliArgs(toolWireSchema(canonical as AiTool), argv, parseOptions);
	if (name === "read" && options.cwd) scopeXdevReadArgs(parsed.args, options.cwd);
	const { result, xdev: dispatch } = await executeResolvedXdev(name, canonical, parsed.args, {
		toolCallId: options.toolCallId,
		signal: options.signal,
		onUpdate: options.onUpdate,
		context: options.context,
		argv,
	});
	return { ...result, details: { xdev: dispatch } };
}

/** Compatibility entry: dispatch a device from its legacy single-string content form. */
export async function dispatchProtolensTarget(
	session: ToolSession,
	name: string | undefined,
	content: string,
	options: ProtolensDispatchOptions,
): Promise<AgentToolResult<unknown>> {
	return dispatchProtolensArgv(session, name, content.length > 0 ? [content] : [], undefined, undefined, options);
}

function resolveDeviceRenderer(
	name: string,
	mounted: Tool | undefined,
): Pick<ToolRenderer, "renderCall" | "renderResult" | "mergeCallAndResult"> | undefined {
	if (mounted && (mounted.renderCall || mounted.renderResult)) {
		return mounted as unknown as Pick<ToolRenderer, "renderCall" | "renderResult" | "mergeCallAndResult">;
	}
	return rendererLookup?.(name);
}

function displayDeviceArgs(args: Record<string, unknown>): Record<string, unknown> {
	const { __partialJson: _partial, ...rest } = args;
	return rest;
}

const HELP_SUMMARY_MAX_CHARS = TRUNCATE_LENGTHS.RECAP;
const HELP_META_MAX_REQUIRED = 4;

/**
 * Per-device TUI identity for the proto built-ins: a family badge rendered on xdev cards so
 * each device family is visually distinct in transcripts and composite listings. Devices not
 * listed here (extensions, MCP bridges) render without a badge.
 */
const XDEV_DEVICE_PROFILES: Record<string, { family: string; color: ToolUIColor }> = {
	read: { family: "files", color: "accent" },
	browser: { family: "web", color: "accent" },
	context: { family: "context", color: "accent" },
	recall: { family: "context", color: "accent" },
	jobs: { family: "execution", color: "accent" },
	fleet: { family: "agents", color: "accent" },
	computer: { family: "desktop", color: "accent" },
	checkpoint: { family: "snapshots", color: "success" },
	rewind: { family: "snapshots", color: "warning" },
	manage_skill: { family: "skills", color: "muted" },
	ask: { family: "user", color: "accent" },
	checklist: { family: "tasks", color: "success" },
	web_search: { family: "search", color: "accent" },
};

function deviceBadge(name: string): { badge: { label: string; color: ToolUIColor } } | undefined {
	const profile = XDEV_DEVICE_PROFILES[name];
	return profile ? { badge: { label: profile.family, color: profile.color } } : undefined;
}

function dispatchTitle(dispatch: XdevDispatch): string {
	return `${PROTOLENS_URL_PREFIX}${dispatch.tool}`;
}

/** Flag rows for the collapsed schema card, Submit-Result tree style. */
function schemaCardRows(mounted: Tool | undefined, name: string): string[] {
	const rows: string[] = [];
	const specs = mounted ? xdevFlagSpecs(toolWireSchema(mounted as AiTool)) : [];
	const jsonOnly = isJsonOnlyDevice(name);
	rows.push(`usage: ${formatCliUsageSynopsis(name, mounted ? toolWireSchema(mounted as AiTool) : {}, { jsonOnly })}`);
	for (const spec of specs) {
		const typeLabel =
			spec.type === "enum"
				? (spec.enumValues?.join("|") ?? "value")
				: spec.type === "array"
					? `${spec.items ?? "string"}…`
					: spec.type === "json"
						? "json"
						: spec.type;
		// JSON-only devices list their JSON keys, not flags they would reject.
		const flag = jsonOnly
			? `${spec.name}: ${typeLabel}`
			: spec.type === "boolean"
				? `--${spec.name}`
				: `--${spec.name} <${typeLabel}>`;
		const required = spec.required ? " (required)" : "";
		// First sentence: a period before a capital, so abbreviations like "e.g. `x`" stay whole.
		const description = spec.description ? ` — ${spec.description.split(/\.\s+(?=[A-Z])/)[0]}` : "";
		rows.push(`${flag}${required}${description}`);
	}
	return rows;
}

/**
 * Description body of rendered docs: everything between the device's `# <name>` heading and the next
 * markdown heading. Anchored on the heading, not the first line, because the bash transport may
 * prepend notices (e.g. shell-state-lost) to the docs text.
 */
function docsDescriptionBody(text: string, name: string): string {
	const lines = text.split("\n");
	const heading = `# ${name}`;
	const start = lines.findIndex(line => line === heading || line.startsWith(`${heading} — `));
	if (start < 0) return "";
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,6} /.test(lines[i])) break;
		body.push(lines[i]);
	}
	return body.join("\n");
}

/** First paragraph flattened to a single bounded line for collapsed previews. */
function flatFirstParagraph(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const paragraph = trimmed.split(/\n[ \t]*\n/)[0] ?? "";
	const flat = paragraph.replace(/\s+/g, " ").trim();
	if (flat.length <= HELP_SUMMARY_MAX_CHARS) return flat;
	return `${flat.slice(0, HELP_SUMMARY_MAX_CHARS).trimEnd()}…`;
}

function helpArgsMeta(mounted: Tool | undefined): string[] {
	const schema = mounted
		? (toolWireSchema(mounted as AiTool) as {
				properties?: Record<string, unknown>;
				required?: readonly string[];
			})
		: undefined;
	const names = Object.keys(schema?.properties ?? {});
	if (names.length === 0) return [];
	const required = (schema?.required ?? []).filter(name => names.includes(name));
	const meta = [`${names.length} ${pluralize("arg", names.length)}`];
	if (required.length > 0) {
		const overflow = required.length - HELP_META_MAX_REQUIRED;
		const shown = required.slice(0, HELP_META_MAX_REQUIRED).join(", ");
		meta.push(`required: ${shown}${overflow > 0 ? ` +${overflow}` : ""}`);
	}
	return meta;
}

function formatXdevHelpCard(
	dispatch: XdevDispatch,
	text: string,
	mounted: Tool | undefined,
	options: RenderResultOptions,
	contentWidth: number,
	theme: Theme,
): string {
	const lines = [
		renderStatusLine(
			{
				icon: options.isPartial ? "running" : "done",
				spinnerFrame: options.spinnerFrame,
				title: dispatchTitle(dispatch),
				meta: ["docs", ...helpArgsMeta(mounted)],
				...deviceBadge(dispatch.tool),
			},
			theme,
		),
	];
	if (options.expanded) {
		lines.push(...formatOutputLines(text, Number.POSITIVE_INFINITY, contentWidth, theme).lines);
		return lines.join("\n");
	}
	const bodyWidth = Math.max(20, contentWidth - 4);
	const description = flatFirstParagraph(docsDescriptionBody(text, dispatch.tool));
	const rows = schemaCardRows(mounted, dispatch.tool);
	const reserved = 1; // expand hint
	const maxRows = Math.max(0, PREVIEW_LIMITS.COLLAPSED_LINES - reserved);
	const visibleRows = rows.slice(0, maxRows);
	for (const [index, row] of visibleRows.entries()) {
		const hook = theme.fg("dim", getTreeBranch(index === visibleRows.length - 1, theme));
		lines.push(` ${hook} ${theme.fg("toolOutput", truncateToWidth(replaceTabs(row), bodyWidth))}`);
	}
	const hiddenRows = rows.length - visibleRows.length;
	const tail: string[] = [];
	if (hiddenRows > 0) tail.push(`… ${hiddenRows} more flags`);
	if (description && rows.length <= maxRows) tail.push(description);
	if (tail.length > 0) {
		lines.push(`  ${theme.fg("dim", truncateToWidth(tail.join(" — "), bodyWidth))}`);
	}
	const hint = formatExpandHint(theme, options.expanded, true);
	if (hint) lines.push(`  ${hint}`);
	return lines.join("\n");
}

function widthAwareText(format: (contentWidth: number) => string): Component {
	const component = new WidthAwareText(format, 0, 0);
	component.setIgnoreTight(true);
	return component;
}

function helpStatusMeta(dispatch: XdevDispatch, resolveMounted?: (name: string) => Tool | undefined): string[] {
	if (dispatch.mode !== "help") return [];
	return ["docs", ...helpArgsMeta(resolveMounted?.(dispatch.tool))];
}

/**
 * The invocation (`package.json:1-4`, `--op list`) that tells repeated devices apart: the typed argv,
 * except JSON payloads, which read better as the flags they decoded to.
 */
function formatDispatchInvocation(dispatch: XdevDispatch): string {
	if (dispatch.mode !== "execute") return "";
	const argv = dispatch.argv ?? [];
	const typedJson = argv[0] === "--json" || argv[0]?.trimStart().startsWith("{");
	if (argv.length > 0 && !(typedJson && dispatch.args)) return argv.map(quoteShellValue).join(" ");
	return formatXdevCliFlags(displayDeviceArgs(dispatch.args ?? {}));
}

function formatDispatchStatusLine(
	dispatch: XdevDispatch,
	options: RenderResultOptions,
	contentWidth: number,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): string {
	const meta =
		dispatch.mode === "listing"
			? [`${dispatch.devices?.length ?? 0} ${pluralize("device", dispatch.devices?.length ?? 0)}`]
			: helpStatusMeta(dispatch, resolveMounted);
	const statusLine = (description?: string) =>
		renderStatusLine(
			{
				icon: dispatch.isError
					? "error"
					: !options.isPartial
						? "done"
						: options.executionStarted === false
							? "pending"
							: "running",
				spinnerFrame: options.spinnerFrame,
				title: dispatchTitle(dispatch),
				...(description ? { description } : {}),
				...(meta.length > 0 ? { meta } : {}),
				...deviceBadge(dispatch.tool),
			},
			theme,
		);
	const invocation = formatDispatchInvocation(dispatch);
	if (!invocation) return statusLine();
	// Budget the invocation so the badge and meta stay visible on narrow terminals.
	const budget = contentWidth - Bun.stringWidth(statusLine()) - 2;
	return budget < 8 ? statusLine() : statusLine(truncateToWidth(replaceTabs(invocation), budget));
}

/** Indented output preview; `hidden` reports whether expanding would reveal more. */
function formatOutputLines(
	text: string,
	maxLines: number,
	contentWidth: number,
	theme: Theme,
): { lines: string[]; hidden: boolean } {
	const trimmed = text.trimEnd();
	if (!trimmed) return { lines: [], hidden: false };
	const bodyWidth = Math.max(20, contentWidth - 2);
	const outputLines = trimmed.split("\n");
	const shown = outputLines.slice(0, maxLines);
	// Device output is externally controlled (extensions, MCP): sanitize before styling.
	const lines = shown.map(
		line => `  ${theme.fg("toolOutput", truncateToWidth(replaceTabs(sanitizeText(line)), bodyWidth))}`,
	);
	const remaining = outputLines.length - shown.length;
	if (remaining > 0) lines.push(`  ${theme.fg("dim", `… ${remaining} more ${pluralize("line", remaining)}`)}`);
	return { lines, hidden: remaining > 0 };
}

/** Device rows of the listing: name column, then the one-line summary. */
function formatListingRows(
	devices: ReadonlyArray<{ name: string; summary: string }>,
	options: RenderResultOptions,
	contentWidth: number,
	theme: Theme,
): { lines: string[]; hidden: boolean } {
	const shown = options.expanded ? devices : devices.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
	const nameWidth = Math.min(24, Math.max(0, ...shown.map(device => Bun.stringWidth(device.name))));
	const summaryWidth = Math.max(20, contentWidth - nameWidth - 4);
	let hidden = devices.length > shown.length;
	const lines: string[] = [];
	for (const device of shown) {
		const name = theme.fg("accent", truncateToWidth(device.name, nameWidth).padEnd(nameWidth));
		const summary = sanitizeText(device.summary).replace(/\s+/g, " ").trim();
		if (options.expanded) {
			const wrapped = Bun.wrapAnsi(summary, summaryWidth, { hard: true, trim: true }).split("\n");
			lines.push(`  ${name}  ${theme.fg("muted", wrapped[0] ?? "")}`);
			for (const rest of wrapped.slice(1)) lines.push(`  ${" ".repeat(nameWidth)}  ${theme.fg("muted", rest)}`);
			continue;
		}
		if (Bun.stringWidth(summary) > summaryWidth) hidden = true;
		lines.push(`  ${name}  ${theme.fg("muted", truncateToWidth(summary, summaryWidth))}`);
	}
	const more = devices.length - shown.length;
	if (more > 0) lines.push(`  ${theme.fg("dim", `… ${more} more ${pluralize("device", more)}`)}`);
	return { lines, hidden };
}

type TextSection = (contentWidth: number) => { lines: string[]; hidden: boolean };

/** A device's status line (device, invocation, outcome), then its own output. */
function deviceTextSection(
	dispatch: XdevDispatch,
	output: string,
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): TextSection {
	return contentWidth => {
		const lines = [formatDispatchStatusLine(dispatch, options, contentWidth, theme, resolveMounted)];
		// Collapsed docs stay a single status line; the docs body is only worth reading expanded.
		if (dispatch.mode === "help" && !options.expanded) return { lines, hidden: output.trim().length > 0 };
		const maxLines = options.expanded ? Number.POSITIVE_INFINITY : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
		const body =
			dispatch.mode === "listing" && dispatch.devices
				? formatListingRows(dispatch.devices, options, contentWidth, theme)
				: formatOutputLines(output, maxLines, contentWidth, theme);
		return { lines: [...lines, ...body.lines], hidden: body.hidden };
	};
}

function stageOutput(stage: ExecutionStageMetadata): string {
	return `${stage.stdout?.text ?? ""}${stage.stderr?.text ?? ""}`;
}

/**
 * Stack sections into one card. Consecutive text sections share one text block with a single expand
 * hint; device renderer cards stand on their own.
 */
function stackSections(parts: ReadonlyArray<Component | TextSection>, options: RenderResultOptions, theme: Theme) {
	const components: Component[] = [];
	let run: TextSection[] = [];
	const flush = () => {
		if (run.length === 0) return;
		const sections = run;
		run = [];
		components.push(
			widthAwareText(width => {
				const rendered = sections.map(section => section(width));
				const lines = rendered.flatMap(section => section.lines);
				const hint = formatExpandHint(
					theme,
					options.expanded,
					rendered.some(section => section.hidden),
				);
				if (hint) lines.push(`  ${hint}`);
				return lines.join("\n");
			}),
		);
	};
	for (const part of parts) {
		if (typeof part === "function") run.push(part);
		else {
			flush();
			components.push(part);
		}
	}
	flush();
	if (components.length === 1) return components[0];
	const box = new Container();
	for (const component of components) box.addChild(component);
	return box;
}

/**
 * One device's section: its docs card, its own result renderer, or its status line and output.
 * `result` holds only this device's output (plus media when it was the whole command).
 */
function deviceSection(
	dispatch: XdevDispatch,
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): Component | TextSection {
	const text = result.content
		.map(block => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
	if (dispatch.mode === "help") {
		const card = renderXdevHelpCard(dispatch, text, resolveMounted?.(dispatch.tool), options, theme);
		if (card) return card;
	}
	if (dispatch.mode === "execute") {
		const card = renderDeviceResult(dispatch, result, options, theme, resolveMounted);
		if (card) return card;
	}
	return deviceTextSection(dispatch, text, options, theme, resolveMounted);
}

function renderXdevHelpCard(
	dispatch: XdevDispatch,
	text: string,
	mounted: Tool | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component | undefined {
	if (!text) return undefined;
	return widthAwareText(width => formatXdevHelpCard(dispatch, text, mounted, options, width, theme));
}

/**
 * The protolens device call when `args.command` is exactly one protolens invocation (no chaining, no
 * surrounding commands). Composite commands render through the composite card instead.
 */
export function protolensDeviceCallFromBashArgs(
	args: unknown,
): { name: string; content?: string; argv?: string[] } | undefined {
	const command = (args as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const segments = tokenizeShellSegments(command);
	if (segments.length !== 1) return undefined;
	const parsed = parseProtolensBashCommand(segments[0]);
	if (parsed?.kind !== "device") return undefined;
	if (parsed.argv.length === 1) {
		// Single-token form: legacy JSON object payload, MCP JSON, or a plain-text device arg.
		return { name: parsed.name, content: parsed.argv[0], argv: parsed.argv };
	}
	return { name: parsed.name, argv: parsed.argv };
}

/** Best-effort CLI argv → args for call previews; parse failures render an empty preview. */
function argsFromXdevArgv(mounted: Tool | undefined, name: string, argv: readonly string[]): Record<string, unknown> {
	if (!mounted) return {};
	try {
		return parseXdevCliArgs(toolWireSchema(mounted as AiTool), argv, {
			deviceName: name,
			jsonOnly: isJsonOnlyDevice(name),
		}).args;
	} catch {
		return {};
	}
}

export function renderXdevCall(
	name: string,
	content: unknown,
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
	argv?: readonly string[],
): Component | undefined {
	const mounted = resolveMounted?.(name);
	const isHelpCall = (typeof content === "string" && HELP_CONTENT_RE.test(content)) || argv?.[0] === "?";
	let dispatch: XdevDispatch = { tool: name, mode: "help" };
	if (!isHelpCall) {
		let args: Record<string, unknown> = {};
		if (typeof content === "string" && content.length > 0) args = decodeInnerArgs(content);
		else if (argv && argv.length > 0) args = argsFromXdevArgv(mounted, name, argv);
		const renderer = resolveDeviceRenderer(name, mounted);
		if (options.executionStarted && renderer?.renderCall) return renderer.renderCall(args, options, theme);
		dispatch = { tool: name, mode: "execute", args, ...(argv && argv.length > 0 ? { argv: [...argv] } : {}) };
	}
	const pending = { ...options, isPartial: true };
	return widthAwareText(width => formatDispatchStatusLine(dispatch, pending, width, theme, resolveMounted));
}

/** The bash result details the protolens card reads. */
export interface ProtolensBashDetails {
	xdev?: unknown;
	deviceResults?: ReadonlyArray<{ stageIndex?: number; xdev?: unknown; isError?: boolean }>;
	execution?: { stages?: readonly ExecutionStageMetadata[] };
	timedOut?: boolean;
	async?: unknown;
	mutatedPaths?: readonly string[];
}

/**
 * The bash command with its device output taken out, so the shell card shows only what the other
 * commands printed. A device's output is removed where it appears whole on its own lines, in stage
 * order; output a pipe or substitution consumed never reached the shell output and stays out of it.
 */
function withoutDeviceOutput(shellOutput: string, deviceStages: readonly ExecutionStageMetadata[]): string {
	let rest = shellOutput;
	let cursor = 0;
	for (const stage of deviceStages) {
		// A truncated capture is only a prefix; removing it would leave the device's tail behind.
		if (stage.stdout?.truncated || stage.stderr?.truncated) continue;
		const output = sanitizeText(stageOutput(stage)).replace(/\n$/, "");
		if (!output) continue;
		let at = rest.indexOf(output, cursor);
		while (at >= 0) {
			const end = at + output.length;
			if ((at === 0 || rest[at - 1] === "\n") && (end === rest.length || rest[end] === "\n")) break;
			at = rest.indexOf(output, at + 1);
		}
		if (at < 0) continue;
		rest = rest.slice(0, at) + rest.slice(at + output.length + (rest[at + output.length] === "\n" ? 1 : 0));
		cursor = at;
	}
	return rest;
}

/**
 * The card for a bash command that ran protolens devices: each device call as its own card with its
 * own output, and the rest of the command as the ordinary shell card, which `renderShell` receives
 * with the device output removed and may omit when nothing is left to show. `undefined` keeps the
 * plain shell card: no dispatch ran, or the shell outcome (timeout, background job, file writes) is
 * what matters.
 */
export function renderProtolensResult(
	details: ProtolensBashDetails | undefined,
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted: ((name: string) => Tool | undefined) | undefined,
	args: unknown,
	shell: { output: string; render: (output: string) => Component | undefined },
): Component | undefined {
	if (!details?.xdev || details.async || details.timedOut || details.mutatedPaths?.length) return undefined;
	const stages = details.execution?.stages ?? [];
	const devices = new Map<number, XdevDispatch>();
	for (const record of details.deviceResults ?? []) {
		if (record.stageIndex === undefined || !isRecord(record.xdev)) continue;
		const dispatch = record.xdev as unknown as XdevDispatch;
		devices.set(record.stageIndex, record.isError ? { ...dispatch, isError: true } : dispatch);
	}
	const deviceStages = stages.filter(stage => devices.has(stage.index));
	if (!options.isPartial && deviceStages.length > 0) {
		// Loops can run a device per iteration; collapsed cards show the first few calls.
		const shown = options.expanded ? deviceStages : deviceStages.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		const cards = shown.map(stage => {
			const dispatch = devices.get(stage.index) as XdevDispatch;
			// A command that was only this device: the result is its output, media included, and uncapped.
			const own =
				stages.length === 1 && !dispatch.isError
					? result
					: { content: [{ type: "text", text: stageOutput(stage) }], isError: dispatch.isError };
			return deviceSection(dispatch, own, options, theme, resolveMounted);
		});
		const more = deviceStages.length - shown.length;
		if (more > 0) {
			cards.push(() => ({
				lines: [theme.fg("dim", `… ${more} more protolens ${pluralize("call", more)}`)],
				hidden: true,
			}));
		}
		const shellCard = stages.length > 1 ? shell.render(withoutDeviceOutput(shell.output, deviceStages)) : undefined;
		if (!shellCard) return stackSections(cards, options, theme);
		// The shell card sits where the command's other work starts: after devices that ran before it.
		const firstShell = stages.find(stage => stage.parent === undefined && !devices.has(stage.index));
		const before = firstShell ? shown.filter(stage => stage.index < firstShell.index).length : cards.length;
		return stackSections([...cards.slice(0, before), shellCard, ...cards.slice(before)], options, theme);
	}
	// No stage records (PTY or client terminal runs) or still streaming: only a bare call maps cleanly.
	const command = (args as { command?: unknown } | undefined)?.command;
	const segments = typeof command === "string" ? tokenizeShellSegments(command) : [];
	const dispatch = details.xdev as XdevDispatch;
	if (segments.length !== 1 || !parseProtolensBashCommand(segments[0]) || Array.isArray(details.xdev)) {
		return undefined;
	}
	return stackSections([deviceSection(dispatch, result, options, theme, resolveMounted)], options, theme);
}

/**
 * The device's own result card. `undefined` when the device has no renderer or failed before
 * producing details (usage/validation errors), which the dispatch card shows instead.
 */
function renderDeviceResult(
	dispatch: XdevDispatch,
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): Component | undefined {
	if (dispatch.isError && dispatch.inner === undefined) return undefined;
	const renderer = resolveDeviceRenderer(dispatch.tool, resolveMounted?.(dispatch.tool));
	if (!renderer?.renderResult) return undefined;
	const innerResult = { content: result.content, details: dispatch.inner, isError: result.isError };
	const parts: Component[] = [];
	if (!renderer.mergeCallAndResult && renderer.renderCall) {
		const call = renderer.renderCall(dispatch.args ?? {}, { ...options, isPartial: false }, theme);
		if (call) parts.push(call);
	}
	const rendered = renderer.renderResult(innerResult, options, theme, dispatch.args ?? {});
	if (rendered) parts.push(rendered);
	if (parts.length <= 1) return parts[0];
	const box = new Container();
	for (const part of parts) box.addChild(part);
	return box;
}
