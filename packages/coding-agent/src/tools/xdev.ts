import type { AgentToolContext, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { type Tool as AiTool, jsonSchemaToTypeScript, toolWireSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { schemaDefinesProperty } from "@oh-my-pi/pi-ai/utils/schema";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { Container } from "@oh-my-pi/pi-tui/tui";
import { INTENT_FIELD, parseStreamingJson, truncateHeadBytes } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { extractUriScheme } from "../internal-urls/parse";
import { XD_URL_PREFIX } from "../internal-urls/xd-protocol";
import { parseMCPToolName } from "../mcp/tool-bridge";
import type { Theme } from "../modes/theme/theme";
import { renderStatusLine } from "../tui/status-line";
import { WidthAwareText } from "../tui/width-aware-text";
import { renderDefaultToolExecution } from "./default-renderer";
import type { Tool, ToolSession } from "./index";
import { isReadableUrlPath, resolveToCwd, splitPathAndSel } from "./path-utils";
import {
	formatBadge,
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
	formatXdevCliCommand,
	parseXdevCliArgs,
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
	inspect_media: true,
};

const XDEV_TRANSPORT_TOOLS: Record<string, true> = { bash: true };

type XdevDocsMode = "inline" | "builtins" | "catalog";

export function isMountableUnderXdev(tool: { name: string; loadMode?: ToolLoadMode }): boolean {
	if (tool.name in XDEV_TRANSPORT_TOOLS || tool.name in XDEV_KEEP_TOP_LEVEL) return false;
	return tool.loadMode === "discoverable";
}

export interface XdevDispatch {
	tool: string;
	mode: "help" | "execute";

	args?: Record<string, unknown>;

	/** Original shell argv when dispatched via the CLI form (`xd browser --action run`). */
	argv?: string[];

	inner?: unknown;

	/** Set by the bash transport when this dispatch failed; drives the error icon in composite cards. */
	isError?: boolean;
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
		description = `${description.slice(0, descriptionCap).trimEnd()}… (full docs: \`xd ${inst.name} ?\`)`;
	}
	const usage =
		cliDetail === "reference"
			? formatCliFlagReference(inst.name, inst as AiTool)
			: `usage: ${formatCliUsageSynopsis(inst.name, wireSchema)}`;
	return {
		prose: [`${heading} ${inst.name}${inst.label ? ` — ${inst.label}` : ""}`, "", description].join("\n"),
		schema: [`${heading}# Schema`, "```ts", `type Args = ${schema};`, "```"].join("\n"),
		footer: [
			usage,
			"",
			`Execute from bash with the flags/positionals above (or \`xd ${inst.name} ?\` for these docs).`,
			`JSON escape hatch: \`xd ${inst.name} --json '<json>'\`, or pipe a JSON args object on stdin; a \`-\` flag value reads stdin. MCP devices accept JSON only.`,
		].join("\n"),
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

function unknownXdKeys(args: Record<string, unknown>, schema: Record<string, unknown>): string[] {
	const accepted = schemaProperties(schema);
	if (!accepted) return [];
	const declared = new Set(accepted);
	return Object.keys(args).filter(key => !declared.has(key));
}

import { suggestKnownKey } from "./xdev-cli";

function validateXdArgs(
	device: AiTool,
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
	const unknown = unknownXdKeys(args, schema);
	if (unknown.length > 0) {
		const accepted = schemaProperties(schema) ?? [];
		const acceptedText = accepted.length > 0 ? accepted.join(", ") : "(none — this device takes no parameters)";
		const hints = unknown
			.map(key => suggestKnownKey(key, accepted))
			.filter((hint): hint is string => hint !== undefined)
			.map(hint => `did you mean \`${hint}\`?`);
		const hintText = hints.length > 0 ? ` ${hints.join(" ")}` : "";
		throw new ToolError(
			`Invalid args for ${XD_URL_PREFIX}${device.name}: unknown top-level key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.${hintText} Accepted keys: ${acceptedText}.`,
		);
	}
	try {
		return validateToolArguments(device, {
			type: "toolCall",
			id: toolCallId,
			name: device.name,
			arguments: args,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Invalid args for ${XD_URL_PREFIX}${device.name}: ${message}\n\n${validationDocs()}`);
	}
}

function parseDeviceArgs(device: AiTool, content: string, toolCallId: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new ToolError(
			`${XD_URL_PREFIX}${device.name} expects a JSON args object as content (${error instanceof Error ? error.message : String(error)}). Write \`?\` for docs.`,
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ToolError(
			`${XD_URL_PREFIX}${device.name} content must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}.`,
		);
	}

	const args: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	const schema = toolWireSchema(device);
	return validateXdArgs(device, args, toolCallId, schema, () => renderDocsParts(device as Tool).schema);
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

function resolveXdevTool(state: XdevState, name: string): Tool | undefined {
	if (name in XDEV_TRANSPORT_TOOLS) return undefined;
	if (!state.mountedNames.has(name) && !state.isActive(name)) return undefined;
	return state.tools.get(name);
}

/** Resolve a mounted device by bare name or by the `xd://name` spelling its docs advertise. */
export function resolveMountedXdevTool(state: XdevState, name: string): Tool | undefined {
	const bare = name.startsWith(XD_URL_PREFIX) ? name.slice(XD_URL_PREFIX.length) : name;
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
	const rows = xdevEntries(state).map(({ name, summary }) => `${XD_URL_PREFIX}${name.padEnd(14)} ${summary}`);
	return [
		`${XD_URL_PREFIX} ${state.mountedNames.size} mounted tool devices.`,
		...rows,
		"",
		`Docs + CLI usage: run \`xd <tool> ?\` in bash; execute with \`xd <tool> [flags]\` or \`xd <tool> --json '<json>'\`. Active top-level tools accept the same dispatch.`,
	].join("\n");
}

export function xdevDocs(state: XdevState, name: string): string {
	return renderDocs(resolveRequiredXdevTool(state, name), "#", undefined, "reference");
}

export function xdevDocsAll(
	state: XdevState,
	mode: XdevDocsMode = "catalog",
	inlinePatterns: readonly string[] = [],
): string {
	const sections: string[] = [];
	const overflow: Tool[] = [];
	const inlineGlobs = compileInlineGlobs(inlinePatterns);
	let used = 0;
	for (const tool of listXdevTools(state)) {
		if (!shouldInlineXdevTool(state, tool, mode, inlineGlobs)) {
			overflow.push(tool);
			continue;
		}
		const descriptionCap = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
		const docs = renderDocs(tool, "##", descriptionCap);
		if (docs.length > XDEV_DOCS_PER_DEVICE_CAP || used + docs.length > XDEV_DOCS_TOTAL_BUDGET) {
			overflow.push(tool);
			continue;
		}
		used += docs.length;
		sections.push(docs);
	}
	if (overflow.length > 0) {
		sections.push(
			[
				"## Additional devices (docs on demand)",
				...overflow.map(tool => {
					const maxBytes = state.builtInNames.has(tool.name) ? undefined : XDEV_EXTERNAL_DESCRIPTION_CAP;
					return `- ${XD_URL_PREFIX}${tool.name} — ${promptCatalogSummary(tool, maxBytes)}`;
				}),
			].join("\n"),
		);
	}
	return sections.join("\n\n");
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
			`No such tool: ${XD_URL_PREFIX}${name}. Mounted devices: ${[...state.mountedNames].join(", ")}. Active top-level tools are also dispatchable via ${XD_URL_PREFIX}<tool>.`,
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
		const validated = validateXdArgs(
			canonical as AiTool,
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
	const validated = parseDeviceArgs(canonical as AiTool, content, toolCallId);
	return executeResolvedXdev(name, canonical, validated, { toolCallId, signal, onUpdate, context });
}

export type XdBashDispatch =
	| { kind: "listing" }
	| {
			kind: "device";
			name: string;
			argv: string[];
			stdin?: string;
			stdinTruncated?: boolean;
	  };

export function parseXdBashCommand(argv: readonly string[]): XdBashDispatch | undefined {
	if (argv.length === 0 || argv[0] !== "xd") return undefined;
	const rest = argv.slice(1);
	if (rest.length === 0 || (rest.length === 1 && HELP_CONTENT_RE.test(rest[0]))) return { kind: "listing" };
	const [name, ...args] = rest;
	return { kind: "device", name, argv: args };
}

export interface XdDispatchOptions {
	toolCallId: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	context?: AgentToolContext;
	cwd?: string;
}

/** `xd <tool> ?` / `help` / `--help` variants request the docs card. */
function isHelpArgv(argv: readonly string[]): boolean {
	return argv.length > 0 && /^(?:\?|help|--help|-h)$/i.test(argv[0]);
}

/**
 * Dispatch an `xd` invocation from the shell bridge: raw argv + captured stdin.
 * CLI flags are mapped through the device wire schema; JSON payloads (single `{...}`
 * positional, `--json`, bare stdin) stay first-class. XdevUsageError propagates so the
 * bridge can exit 2 (usage) instead of 1 (tool failure).
 */
export async function dispatchXdArgv(
	session: ToolSession,
	name: string | undefined,
	argv: readonly string[],
	stdin: string | undefined,
	stdinTruncated: boolean | undefined,
	options: XdDispatchOptions,
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
		throw new ToolError("xd:// is not mounted in this session.");
	}
	if (!name) {
		throw new ToolError(`Cannot dispatch to ${XD_URL_PREFIX} itself — pick a device:\n${xdevListing(xdev)}`);
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
		jsonOnly: parseMCPToolName(name) !== null,
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
export async function dispatchXdTarget(
	session: ToolSession,
	name: string | undefined,
	content: string,
	options: XdDispatchOptions,
): Promise<AgentToolResult<unknown>> {
	return dispatchXdArgv(session, name, content.length > 0 ? [content] : [], undefined, undefined, options);
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

function displayDeviceLabel(name: string, mounted?: { label?: string }): string {
	if (mounted?.label) return mounted.label;
	const parsed = parseMCPToolName(name);
	if (parsed) return `${parsed.serverName}/${parsed.toolName}`;
	return name;
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
	monitor: { family: "watch", color: "warning" },
	fleet: { family: "processes", color: "accent" },
	orchestrate_spawn: { family: "workers", color: "accent" },
	orchestrate_send: { family: "workers", color: "accent" },
	orchestrate_wait: { family: "workers", color: "accent" },
	orchestrate_kill: { family: "workers", color: "error" },
	orchestrate_list: { family: "workers", color: "accent" },
	computer: { family: "desktop", color: "accent" },
	checkpoint: { family: "snapshots", color: "success" },
	rewind: { family: "snapshots", color: "warning" },
	manage_skill: { family: "skills", color: "muted" },
	ask: { family: "user", color: "accent" },
	checklist: { family: "tasks", color: "success" },
	web_search: { family: "search", color: "accent" },
	inspect_media: { family: "media", color: "accent" },
};

function deviceBadge(name: string, theme: Theme): string | undefined {
	const profile = XDEV_DEVICE_PROFILES[name];
	return profile ? formatBadge(profile.family, profile.color, theme) : undefined;
}

/** Flag rows for the collapsed schema card, Submit-Result tree style. */
function schemaCardRows(mounted: Tool | undefined, name: string): string[] {
	const rows: string[] = [];
	const specs = mounted ? xdevFlagSpecs(toolWireSchema(mounted as AiTool)) : [];
	rows.push(`usage: ${formatCliUsageSynopsis(name, mounted ? toolWireSchema(mounted as AiTool) : {})}`);
	for (const spec of specs) {
		const typeLabel =
			spec.type === "enum"
				? (spec.enumValues?.join("|") ?? "value")
				: spec.type === "array"
					? `${spec.items ?? "string"}…`
					: spec.type === "json"
						? "json"
						: spec.type;
		const flag = spec.type === "boolean" ? `--${spec.name}` : `--${spec.name} <${typeLabel}>`;
		const required = spec.required ? " (required)" : "";
		const description = spec.description ? ` — ${spec.description.split(/\. /)[0]}` : "";
		rows.push(`${flag}${required}${description}`);
	}
	return rows;
}

/** Description body of rendered docs: everything between the heading and the next markdown heading. */
function docsDescriptionBody(text: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex(line => line.trim().length > 0);
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
	const badge = deviceBadge(dispatch.tool, theme);
	const lines = [
		renderStatusLine(
			{
				icon: options.isPartial ? "running" : "done",
				spinnerFrame: options.spinnerFrame,
				title: `${XD_URL_PREFIX}${dispatch.tool}`,
				meta: ["docs", ...helpArgsMeta(mounted)],
				...(badge
					? {
							badge: {
								label: XDEV_DEVICE_PROFILES[dispatch.tool].family,
								color: XDEV_DEVICE_PROFILES[dispatch.tool].color,
							},
						}
					: {}),
			},
			theme,
		),
	];
	if (options.expanded) {
		for (const line of text.split("\n")) {
			lines.push(theme.fg("toolOutput", replaceTabs(line)));
		}
		return lines.join("\n");
	}
	const bodyWidth = Math.max(20, contentWidth - 4);
	const hook = theme.fg("dim", theme.tree.last);
	const description = flatFirstParagraph(docsDescriptionBody(text));
	const rows = schemaCardRows(mounted, dispatch.tool);
	const reserved = 1; // expand hint
	const maxRows = Math.max(0, PREVIEW_LIMITS.COLLAPSED_LINES - reserved);
	const visibleRows = rows.slice(0, maxRows);
	for (const row of visibleRows) {
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
	const component = new WidthAwareText(format, 1, 1);
	component.setIgnoreTight(true);
	return component;
}

function helpStatusMeta(dispatch: XdevDispatch, resolveMounted?: (name: string) => Tool | undefined): string[] {
	if (dispatch.mode !== "help") return [];
	return ["docs", ...helpArgsMeta(resolveMounted?.(dispatch.tool))];
}

function formatXdevCompositeCard(
	dispatches: readonly XdevDispatch[],
	text: string,
	options: RenderResultOptions,
	contentWidth: number,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): string {
	const lines: string[] = [];
	for (const dispatch of dispatches) {
		const meta = helpStatusMeta(dispatch, resolveMounted);
		const badge = deviceBadge(dispatch.tool, theme);
		lines.push(
			renderStatusLine(
				{
					icon: dispatch.isError ? "error" : "done",
					title: `${XD_URL_PREFIX}${dispatch.tool}`,
					...(meta.length > 0 ? { meta } : {}),
					...(badge
						? {
								badge: {
									label: XDEV_DEVICE_PROFILES[dispatch.tool].family,
									color: XDEV_DEVICE_PROFILES[dispatch.tool].color,
								},
							}
						: {}),
				},
				theme,
			),
		);
	}

	const outputLines = text.trimEnd() ? text.trimEnd().split("\n") : [];
	const bodyWidth = Math.max(20, contentWidth - 2);
	const maxLines = options.expanded ? Number.POSITIVE_INFINITY : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const shown = outputLines.slice(0, maxLines);
	for (const line of shown) {
		lines.push(`  ${theme.fg("toolOutput", truncateToWidth(replaceTabs(line), bodyWidth))}`);
	}
	const remaining = outputLines.length - shown.length;
	if (remaining > 0) {
		const more = theme.fg("dim", `… ${remaining} more lines`);
		const hint = formatExpandHint(theme, options.expanded, true);
		lines.push(`  ${[more, hint].filter(Boolean).join(" ")}`);
	} else if (!options.expanded) {
		const hint = formatExpandHint(theme, options.expanded, true);
		if (hint) lines.push(`  ${hint}`);
	}
	return lines.join("\n");
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
 * The xd device call when `args.command` is exactly one xd invocation (no chaining, no
 * surrounding commands). Composite commands render through the composite card instead.
 */
export function xdDeviceCallFromBashArgs(
	args: unknown,
): { name: string; content?: string; argv?: string[] } | undefined {
	const command = (args as { command?: unknown } | undefined)?.command;
	if (typeof command !== "string") return undefined;
	const segments = tokenizeShellSegments(command);
	if (segments.length !== 1) return undefined;
	const parsed = parseXdBashCommand(segments[0]);
	if (parsed?.kind !== "device") return undefined;
	if (parsed.argv.length === 1) {
		// Single-token form: legacy JSON object payload, MCP JSON, or a plain-text device arg.
		return { name: parsed.name, content: parsed.argv[0], argv: parsed.argv };
	}
	return { name: parsed.name, argv: parsed.argv };
}

function renderQueuedXdevCall(
	label: string,
	args: Record<string, unknown>,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return renderDefaultToolExecution(
		{
			label: `queued ${label}`,
			args: displayDeviceArgs(args),
			options: { ...options, isPartial: true, spinnerFrame: undefined },
		},
		theme,
	);
}

/** Best-effort CLI argv → args for call previews; parse failures render an empty preview. */
function argsFromXdevArgv(mounted: Tool | undefined, name: string, argv: readonly string[]): Record<string, unknown> {
	if (!mounted) return {};
	try {
		return parseXdevCliArgs(toolWireSchema(mounted as AiTool), argv, {
			deviceName: name,
			jsonOnly: parseMCPToolName(name) !== null,
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
	if (isHelpCall) {
		return renderDefaultToolExecution({ label: `xd ${displayDeviceLabel(name, mounted)}`, args: {}, options }, theme);
	}
	let args: Record<string, unknown>;
	if (typeof content === "string" && content.length > 0) {
		args = decodeInnerArgs(content);
	} else if (argv && argv.length > 0) {
		args = argsFromXdevArgv(mounted, name, argv);
	} else {
		args = {};
	}
	if (!options.executionStarted) {
		return renderQueuedXdevCall(displayDeviceLabel(name, mounted), args, options, theme);
	}
	const renderer = resolveDeviceRenderer(name, mounted);
	if (renderer?.renderCall) {
		return renderer.renderCall(args, options, theme);
	}
	if (argv && argv.length > 0) {
		// No device-specific renderer: preview the typed CLI command instead of JSON args.
		return renderDefaultToolExecution({ label: formatXdevCliCommand(name, args), args: {}, options }, theme);
	}
	return renderDefaultToolExecution({ label: mounted?.label ?? name, args, options }, theme);
}

export function renderXdevResult(
	dispatch: XdevDispatch | readonly XdevDispatch[],
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
	singleCall?: { name: string; content?: string; argv?: string[] },
): Component | undefined {
	const dispatches = Array.isArray(dispatch) ? dispatch : [dispatch];
	const text = result.content
		.map(block => (block.type === "text" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
	if (dispatches.length === 1 && singleCall) {
		const only = dispatches[0];
		if (only.mode === "help") {
			return renderXdevHelpCard(only, text, resolveMounted?.(only.tool), options, theme);
		}
		return renderSingleXdevExecute(only, text, result, options, theme, resolveMounted);
	}
	return widthAwareText(width => formatXdevCompositeCard(dispatches, text, options, width, theme, resolveMounted));
}

function renderSingleXdevExecute(
	dispatch: XdevDispatch,
	text: string,
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	resolveMounted?: (name: string) => Tool | undefined,
): Component | undefined {
	const mounted = resolveMounted?.(dispatch.tool);
	const renderer = resolveDeviceRenderer(dispatch.tool, mounted);
	const innerResult = { content: result.content, details: dispatch.inner, isError: result.isError };
	if (renderer?.renderResult) {
		const parts: Component[] = [];

		if (!renderer.mergeCallAndResult && renderer.renderCall) {
			const call = renderer.renderCall(dispatch.args ?? {}, { ...options, isPartial: false }, theme);
			if (call) parts.push(call);
		}
		const rendered = renderer.renderResult(innerResult, options, theme, dispatch.args ?? {});
		if (rendered) parts.push(rendered);
		if (parts.length === 1) return parts[0];
		if (parts.length > 1) {
			const box = new Container();
			for (const part of parts) box.addChild(part);
			return box;
		}
	}
	return renderDefaultToolExecution(
		{
			label: mounted?.label ?? dispatch.tool,
			args: dispatch.args ?? {},
			result: { output: text, isError: result.isError },
			options,
		},
		theme,
	);
}
