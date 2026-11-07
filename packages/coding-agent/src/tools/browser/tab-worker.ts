import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { logger, postmortem, Snowflake, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { HTMLElement } from "@oh-my-pi/pi-utils/dom";
import type {
	Browser,
	CDPSession,
	Dialog,
	ElementHandle,
	ElementScreenshotOptions,
	Frame,
	HTTPRequest,
	HTTPResponse,
	JSHandle,
	KeyboardTypeOptions,
	KeyInput,
	KeyPressOptions,
	MouseButton,
	Page,
	Realm,
	SerializedAXNode,
	Target,
	WaitForOptions,
} from "puppeteer-core";
import { JsRuntime, type RuntimeHooks } from "../../eval/js/shared/runtime";
import { resizeImage } from "../../utils/image-resize";
import { resolveToCwd } from "../path-utils";
import { formatScreenshot } from "../render-utils";
import {
	bindRunFacade,
	CELL_BUDGET_SLACK_MS,
	installBrowserWorkerRejectionGuard,
	isBrowserRunOwnedRejection,
	markBrowserRunRejection,
	markHandled,
	observeBrowserRunPromise,
	resolvePredicateTimeout,
	type WaitPredicateOptions,
	waitForRun,
	withBrowserPromiseCombinatorTracking,
} from "../run-scope";
import { ToolAbortError, ToolError, throwIfAborted } from "../tool-errors";
import {
	type AriaSnapshotOptions,
	assertSelectorString,
	captureAriaSnapshot,
	parseAriaRefSelector,
	resolveAriaRefHandle,
} from "./aria/aria-snapshot";
import {
	applyStealthPatches,
	applyViewport,
	BROWSER_PROTOCOL_TIMEOUT_MS,
	browserConnection,
	connectPuppeteer,
	DEFAULT_VIEWPORT,
	isPuppeteerTargetClose,
	isPuppeteerTimeout,
	loadPuppeteerInWorker,
	puppeteerTimeoutError,
} from "./launch";
import { extractReadableFromHtml, type ReadableFormat } from "./readable";
import { RunOutput } from "./run-output";
import { assertTabPressArgs } from "./tab-arguments";
import type {
	Observation,
	ObservationEntry,
	ReadyInfo,
	RunErrorPayload,
	ScreenshotResult,
	SessionSnapshot,
	ToolReply,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
} from "./tab-protocol";
import { ownsPage } from "./tab-protocol";

declare module "puppeteer-core" {
	interface Frame {
		readonly _lifecycleEvents: ReadonlySet<string>;
		readonly _loaderId: string;
		readonly client: CDPSession;
		readonly accessibility: Page["accessibility"];
		mainRealm(): Realm;
	}
	interface Realm {
		adoptBackendNode(backendNodeId: number): Promise<JSHandle>;
		/** Re-home a DOM handle into this realm (`@internal` in puppeteer, stripped from published types). */
		adoptHandle<T extends JSHandle>(handle: T): Promise<T>;
	}
	interface SerializedAXNode {
		readonly backendNodeId?: number;
		readonly loaderId: string;
	}
	interface JSHandle {
		/** Realm that created this handle (`@internal` in puppeteer, stripped from published types). */
		readonly realm: Realm;
	}
}

declare global {
	interface Element extends HTMLElement {}
	function getComputedStyle(element: Element): Record<string, unknown>;
	var innerWidth: number;
	var innerHeight: number;
	var document: {
		elementFromPoint(x: number, y: number): Element | null;
		readonly visibilityState: "visible" | "hidden";
	};
}

const INTERACTIVE_AX_ROLES = new Set([
	"button",
	"link",
	"textbox",
	"combobox",
	"listbox",
	"option",
	"checkbox",
	"radio",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"slider",
	"spinbutton",
	"searchbox",
	"treeitem",
]);

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

const SELECTOR_HANDLER_PREFIXES = [
	"aria/",
	"text/",
	"xpath/",
	"pierce/",
	"aria-ref=",
	"aria-ref/",
	"ariaref/",
	"p-",
] as const;

const PLAYWRIGHT_ONLY_SELECTOR_RE =
	/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b|:hidden\b|:nth-match\(|:near\(|:above\(|:below\(|:right-of\(|:left-of\(/;

type DialogPolicy = "accept" | "dismiss";
type DragTarget = string | { readonly x: number; readonly y: number };

interface OpenDialogInfo {
	type: string;
	message: string;
}

const FRAME_SNAPSHOT_TIMEOUT_MS = 1_000;
const QUICK_OP_TIMEOUT_MS = 20_000;
const ACTION_OP_TIMEOUT_MS = 8_000;

const SCROLL_ACK_TIMEOUT_MS = 2_000;

const OP_DEADLINE_SLACK_MS = CELL_BUDGET_SLACK_MS;

const ZERO_MATCH_FAIL_FAST_MS = 2_000;

const ZERO_MATCH_POLL_MS = 250;

const REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 500;
const HANDLE_ACTION_INVALIDATION_TIMEOUT_MS = 500;

interface OpTimeouts {
	budgetBound: number;

	quickOpMs: number;

	actionOpMs: number;
}

export function resolveOpTimeouts(cellTimeoutMs: number): OpTimeouts {
	const budgetBound = Math.max(1, cellTimeoutMs - OP_DEADLINE_SLACK_MS);
	return {
		budgetBound,
		quickOpMs: Math.min(budgetBound, QUICK_OP_TIMEOUT_MS),
		actionOpMs: Math.min(budgetBound, ACTION_OP_TIMEOUT_MS),
	};
}

export async function dispatchScroll(
	dispatch: () => Promise<void>,
	ackTimeoutMs = SCROLL_ACK_TIMEOUT_MS,
): Promise<void> {
	const deadline = Promise.withResolvers<void>();
	const timer = setTimeout(() => deadline.resolve(), ackTimeoutMs);
	timer.unref();
	try {
		await Promise.race([dispatch(), deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

export function resolveWaitTimeout(cellTimeoutMs: number, explicit?: number): number {
	const { budgetBound, actionOpMs } = resolveOpTimeouts(cellTimeoutMs);
	if (explicit === undefined) return actionOpMs;

	if (explicit === 0 || explicit === Number.POSITIVE_INFINITY) return budgetBound;

	if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, budgetBound);
	return actionOpMs;
}

interface ScreenshotOptions {
	selector?: string;
	fullPage?: boolean;
	silent?: boolean;
}

interface TabActionOptions {
	timeout?: number;
}

interface TabApi {
	readonly name: string;
	readonly page: Page;
	readonly signal?: AbortSignal;
	url(): string;
	title(): Promise<string>;
	text(selector?: string): Promise<string>;
	html(selector?: string): Promise<string>;
	goto(
		url: string,
		opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeout?: number },
	): Promise<void>;
	observe(opts?: { includeAll?: boolean; viewportOnly?: boolean; selector?: string }): Promise<Observation>;
	ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string>;
	screenshot(opts?: ScreenshotOptions): Promise<string>;
	extract(format?: ReadableFormat): Promise<string>;
	click(selector: string, opts?: TabActionOptions & { button?: MouseButton; count?: number }): Promise<void>;
	type(selector: string, text: string, opts?: TabActionOptions): Promise<void>;
	fill(selector: string, value: string, opts?: TabActionOptions): Promise<void>;
	press(key: string, opts?: TabActionOptions & { selector?: string }): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	drag(from: DragTarget, to: DragTarget): Promise<void>;
	waitFor(selector: string, opts?: { timeout?: number }): Promise<ActionableHandle>;
	evaluate<TResult, TArgs extends unknown[]>(
		fn: string | ((...args: TArgs) => TResult | Promise<TResult>),
		...args: TArgs
	): Promise<TResult>;
	scrollIntoView(selector: string): Promise<void>;
	select(selector: string, ...values: Array<string | TabActionOptions>): Promise<string[]>;
	uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
	waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
	waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		opts?: { timeout?: number },
	): Promise<HTTPResponse>;
	waitForSelector(
		selector: string,
		opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
	): Promise<ActionableHandle | null>;
	waitForNavigation(opts?: {
		waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
		timeout?: number;
	}): Promise<HTTPResponse | null>;
	id(n: number): Promise<ActionableHandle>;
	ref(id: string): Promise<ActionableHandle>;
}

export function normalizeSelector(selector: string): string {
	assertSelectorString(selector);
	if (!selector) return selector;
	if (
		!SELECTOR_HANDLER_PREFIXES.some(prefix => selector.startsWith(prefix)) &&
		PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)
	) {
		throw new ToolError(
			`Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. ` +
				`Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`,
		);
	}
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}

function isInteractiveNode(node: SerializedAXNode): boolean {
	if (INTERACTIVE_AX_ROLES.has(node.role)) return true;
	return (
		node.checked !== undefined ||
		node.pressed !== undefined ||
		node.selected !== undefined ||
		node.expanded !== undefined ||
		node.focused === true
	);
}

function asElementHandle(handle: unknown): ElementHandle | null {
	return handle ? (handle as ElementHandle) : null;
}

type ActionableHandle = ElementHandle & { fill(value: string): Promise<void> };

/** Runs `fn` inside the active run's fail-fast per-op deadline, like the selector-based helpers. */
export type HandleOpGuard = <T>(label: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/** Every handle method that dispatches input, pointer/touch, drag, or navigation work and can stall a busy page. */
const GUARDED_HANDLE_METHODS = [
	"click",
	"type",
	"hover",
	"tap",
	"focus",
	"press",
	"select",
	"uploadFile",
	"scrollIntoView",
	"drag",
	"dragEnter",
	"dragOver",
	"drop",
	"dragAndDrop",
	"touchStart",
	"touchMove",
	"touchEnd",
	"autofill",
] as const satisfies readonly (keyof ElementHandle)[];

type GuardedHandleMethod = (typeof GUARDED_HANDLE_METHODS)[number];
type RawHandleMethod = (...args: unknown[]) => Promise<unknown>;

interface RawHandleMethods {
	interactive: Partial<Record<GuardedHandleMethod, RawHandleMethod>>;
	type: ElementHandle["type"];
	invalidatedBy?: string;
}

// Original bound methods travel with each cached handle so every run rewraps from them, never from wrappers that
// retain an earlier run's guard.
const RAW_HANDLE_METHODS = Symbol("browser.rawHandleMethods");

type HandleWithRawMethods = ActionableHandle & { [RAW_HANDLE_METHODS]?: RawHandleMethods };

// Raw puppeteer actions take no AbortSignal: a timed-out action poisons and disposes its handle before surfacing the
// error, so a caught retry on the stale handle cannot dispatch a duplicate action.
async function runGuardedHandleAction<T>(
	handle: ElementHandle,
	state: RawHandleMethods,
	label: string,
	signal: AbortSignal,
	action: () => Promise<T>,
	invalidate?: () => Promise<void>,
): Promise<T> {
	if (state.invalidatedBy) {
		throw new ToolError(
			`${label} cannot run: this handle was invalidated after ${state.invalidatedBy} timed out; ` +
				"run tab.observe() or tab.ariaSnapshot() to resolve a fresh handle",
		);
	}
	throwIfAborted(signal);
	const pending = action();
	try {
		return await untilAborted(signal, () => pending);
	} catch (error) {
		if (!signal.aborted) throw error;
		state.invalidatedBy = label;
		void pending.catch(() => undefined);
		await withTimeout(
			Promise.all([handle.dispose().catch(() => undefined), invalidate?.().catch(() => undefined)]),
			HANDLE_ACTION_INVALIDATION_TIMEOUT_MS,
			`Timed out invalidating ${label}`,
		).catch(() => undefined);
		throw error;
	}
}

/**
 * Attach `fill()` to a handle and, with a `guard`, route every interactive method through the per-op fail-fast
 * wrapper so `(await tab.id(n)).click()` fails with `handle.click() timed out after …ms` instead of stalling the
 * whole cell.
 */
export function toActionableHandle(
	handle: ElementHandle,
	guard?: HandleOpGuard,
	invalidate?: () => Promise<void>,
	upload?: (paths: string[], signal: AbortSignal) => Promise<void>,
): ActionableHandle {
	const enriched = handle as HandleWithRawMethods;
	const methods = enriched as unknown as Partial<Record<GuardedHandleMethod, RawHandleMethod>>;
	const preserved = enriched[RAW_HANDLE_METHODS];
	if (!guard) {
		if (preserved) {
			for (const method of GUARDED_HANDLE_METHODS) {
				const original = preserved.interactive[method];
				if (original) methods[method] = original;
			}
		}
		enriched.fill = value => fillViaHandle(enriched, value);
		return enriched;
	}

	let originals = preserved;
	if (!originals) {
		const interactive: Partial<Record<GuardedHandleMethod, RawHandleMethod>> = {};
		for (const method of GUARDED_HANDLE_METHODS) {
			const original = methods[method];
			if (typeof original === "function") interactive[method] = original.bind(enriched);
		}
		originals = { interactive, type: enriched.type.bind(enriched) };
		enriched[RAW_HANDLE_METHODS] = originals;
	}
	const state = originals;
	const focus = state.interactive.focus;
	if (focus) {
		methods.press = (key, options) =>
			guard("handle.press()", signal =>
				runGuardedHandleAction(
					enriched,
					state,
					"handle.press()",
					signal,
					async () => {
						await untilAborted(signal, focus);
						await pressKey(enriched.frame.page(), key as string, options as KeyPressOptions | undefined, signal);
					},
					invalidate,
				),
			);
	}
	state.interactive.select = (...values) => selectElementOptions(enriched, values as string[], "handle.select()");
	if (upload) {
		methods.uploadFile = (...paths) =>
			guard("handle.uploadFile()", signal =>
				runGuardedHandleAction(
					enriched,
					state,
					"handle.uploadFile()",
					signal,
					() => upload(paths as string[], signal),
					invalidate,
				),
			);
	}

	for (const method of GUARDED_HANDLE_METHODS) {
		if (method === "type" || (method === "press" && focus) || (method === "uploadFile" && upload)) continue;
		const original = state.interactive[method];
		if (!original) continue;
		const label = `handle.${method}()`;
		methods[method] = (...args) =>
			guard(label, signal =>
				runGuardedHandleAction(enriched, state, label, signal, () => original(...args), invalidate),
			);
	}
	enriched.type = (text, options) =>
		guard<void>("handle.type()", signal =>
			runGuardedHandleAction(
				enriched,
				state,
				"handle.type()",
				signal,
				() => typeIntoElement(enriched, text, signal, options),
				invalidate,
			),
		);
	enriched.fill = value =>
		guard<void>("handle.fill()", signal =>
			runGuardedHandleAction(
				enriched,
				state,
				"handle.fill()",
				signal,
				() => fillViaHandle(enriched, value, signal),
				invalidate,
			),
		);
	return enriched;
}

/**
 * Re-home element handles in `args` into `realm`: selectors resolve in puppeteer's isolated world while
 * `tab.evaluate` runs in the main world, and CDP rejects a handle used outside its creating context. Only DOM element
 * handles can cross worlds; others pass through. `dispose()` releases the adopted copies, never the originals.
 */
async function adoptElementArgs(
	realm: Realm,
	args: unknown[],
): Promise<{ args: unknown[]; dispose: () => Promise<void> }> {
	const adopted: JSHandle[] = [];
	const dispose = async (): Promise<void> => {
		await Promise.all(adopted.map(handle => handle.dispose().catch(() => undefined)));
	};
	const out = args.slice();
	try {
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			const element = arg instanceof Object && "asElement" in arg ? (arg as JSHandle).asElement() : null;
			if (!element || element.realm === realm) continue;
			const copy = await realm.adoptHandle(element);
			adopted.push(copy);
			out[i] = copy;
		}
	} catch (error) {
		await dispose();
		throw error;
	}
	return { args: out, dispose };
}

interface ClickAtOptions {
	button?: MouseButton;
	clickCount?: number;
}
interface MouseButtonOptions {
	button?: MouseButton;
}

interface ClickPoint {
	x: number;
	y: number;
}

type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string; coveredBy?: string };

interface PageRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}

interface PageRoot {
	host?: PageElement;
}

interface PageShadowRoot {
	elementFromPoint(x: number, y: number): PageElement | null;
}

/** An element on the way up to a contenteditable's editing host. */
interface EditableAncestor {
	isContentEditable: boolean;
	parentElement: EditableAncestor | null;
	focus(): void;
	contains(other: unknown): boolean;
}

interface PageElement {
	readonly tagName: string;
	id: string;
	readonly isConnected: boolean;
	type: string;
	checked: boolean;
	files: unknown;
	inert: boolean;
	readonly labels?: ArrayLike<PageElement> | null;
	matches(selector: string): boolean;
	readonly classList: ArrayLike<string>;
	readonly dataset: Record<string, string>;
	readonly style: Record<string, string>;
	parentElement: PageElement | null;
	/** The `<slot>` rendering this node, its parent in the flat tree; `null` when unslotted. */
	assignedSlot: PageElement | null;
	shadowRoot: PageShadowRoot | null;
	getBoundingClientRect(): PageRect;
	getClientRects(): ArrayLike<PageRect>;
	getRootNode(): PageRoot;
	contains(other: PageElement): boolean;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	dispatchEvent(event: unknown): boolean;
	scrollIntoView(options: { behavior: string; block: string; inline: string }): void;
	remove(): void;
}

interface PageDocument {
	elementFromPoint(x: number, y: number): PageElement | null;
	createElement(tag: string): PageElement;
	getElementById(id: string): PageElement | null;
	documentElement: { append(element: PageElement): void };
}

interface PageGlobals {
	document: PageDocument;
	innerWidth: number;
	innerHeight: number;
	getComputedStyle(element: PageElement): {
		display: string;
		visibility: string;
		pointerEvents: string;
		opacity: string;
	};
	Event: new (type: string, options: { bubbles: boolean; composed?: boolean }) => unknown;
	File: new (parts: Uint8Array[], name: string, options: { type: string; lastModified?: number }) => unknown;
	DataTransfer: new () => { items: { add(file: unknown): void }; files: unknown };
	DragEvent: new (type: string, options: { bubbles: boolean; cancelable: boolean; dataTransfer: unknown }) => unknown;
	MessageChannel: new () => {
		port1: { onmessage: (() => void) | null; close(): void };
		port2: { postMessage(message: null): void; close(): void };
	};
}

/** A click aborted while its element was still refused; `refusal` names the last failed check. */
export class ClickRefusedError extends ToolAbortError {
	constructor(
		readonly refusal: string,
		options?: ErrorOptions,
	) {
		super(undefined, options);
	}
}

/**
 * Text entry aborted after input reached the page; `progress` says what the field may already hold.
 * The per-op timeout reports this instead of an actionability hint, since the element did take input.
 */
export class TypingInterruptedError extends ToolAbortError {
	constructor(
		readonly progress: string,
		options?: ErrorOptions,
	) {
		super(undefined, options);
	}
}

export function composedContains(ancestor: unknown, descendant: unknown): boolean {
	for (let current = descendant as PageElement | null; current; ) {
		if (current === ancestor) return true;
		const root: PageRoot = current.getRootNode();
		current = current.assignedSlot ?? current.parentElement ?? root.host ?? null;
	}
	return false;
}

interface ClickFlags {
	viaLabel: boolean;
}

/** Page half of {@link isClickActionable}; `contains` is {@link composedContains}, bound in by `clickActionableInPage`. */
function checkClickActionable(
	el: unknown,
	{ viaLabel }: ClickFlags,
	contains: typeof composedContains,
): ActionabilityResult {
	const element = el as unknown as PageElement;
	const page = globalThis as unknown as PageGlobals;
	// A node the page replaced (e.g. a re-render) has no computed style; say so rather than misread it.
	if (!element.isConnected) {
		return { ok: false as const, reason: "detached (the page replaced this element; look it up again)" };
	}
	const style = page.getComputedStyle(element);
	if (style.display === "none") return { ok: false as const, reason: "display:none" };
	if (style.visibility === "hidden" || style.visibility === "collapse") {
		return { ok: false as const, reason: `visibility:${style.visibility}` };
	}
	if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
	// A custom checkbox or radio keeps its real control at opacity:0 under the box it draws; the hit test below decides.
	if (
		Number(style.opacity) === 0 &&
		!element.matches(
			'input[type="checkbox"], input[type="radio"], [role="checkbox" i], [role="radio" i], [role="switch" i]',
		)
	) {
		return { ok: false as const, reason: "opacity:0" };
	}
	const rect = element.getBoundingClientRect();
	if (rect.width < 1 || rect.height < 1) return { ok: false as const, reason: "zero-size" };
	// A wrapped link's box centre can fall between its lines, on the parent; aim at its first visible line.
	const fragments = Array.from(element.getClientRects());
	const box =
		fragments.length === 0
			? rect
			: fragments.find(
					r =>
						Math.min(page.innerWidth, r.right) - Math.max(0, r.left) >= 1 &&
						Math.min(page.innerHeight, r.bottom) - Math.max(0, r.top) >= 1,
				);
	if (!box) return { ok: false as const, reason: "off-viewport" };
	const left = Math.max(0, Math.min(page.innerWidth, box.left));
	const right = Math.max(0, Math.min(page.innerWidth, box.right));
	const top = Math.max(0, Math.min(page.innerHeight, box.top));
	const bottom = Math.max(0, Math.min(page.innerHeight, box.bottom));
	if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };
	const x = Math.floor((left + right) / 2);
	const y = Math.floor((top + bottom) / 2);
	let topElement = page.document.elementFromPoint(x, y);
	for (let depth = 0; topElement?.shadowRoot && depth < 16; depth++) {
		const nested = topElement.shadowRoot.elementFromPoint(x, y);
		if (!nested || nested === topElement) break;
		topElement = nested;
	}
	if (!topElement) return { ok: false as const, reason: "elementFromPoint-null" };
	// A label forwards a click to its control unless the hit is other interactive content inside it.
	const interactiveContent =
		'a[href], area[href], button, details, embed, iframe, input:not([type="hidden"]), label, select, textarea, summary, audio[controls], video[controls], [contenteditable=""], [contenteditable="true"]';
	const hit: PageElement = topElement;
	const forwardedBy = (owner: PageElement): boolean => {
		let current: PageElement | null = hit;
		while (current && current !== owner) {
			if (current.matches(interactiveContent)) return false;
			current = current.assignedSlot ?? current.parentElement ?? current.getRootNode().host ?? null;
		}
		return current === owner;
	};
	const onTarget =
		contains(element, topElement) ||
		contains(topElement, element) ||
		(viaLabel && Array.from(element.labels ?? []).some(forwardedBy));
	if (!onTarget) {
		const tag = topElement.tagName.toLowerCase();
		const id = topElement.id ? `#${topElement.id}` : "";
		const classes = Array.from(topElement.classList)
			.slice(0, 2)
			.map(name => `.${name}`)
			.join("");
		return { ok: false as const, reason: "covered", coveredBy: `<${tag}${id}${classes}>` };
	}
	return { ok: true as const, x: x - rect.left, y: y - rect.top };
}

/** {@link checkClickActionable} with {@link composedContains} bound in, as one self-contained page function. */
const clickActionableInPage = new Function(
	"el",
	"flags",
	`return (${checkClickActionable.toString()})(el, flags, ${composedContains.toString()});`,
) as (el: unknown, flags: ClickFlags) => ActionabilityResult;

/**
 * Return a visible point relative to the element's box, or explain why it cannot receive a click.
 * A left click on one of the control's own `<label>`s counts as on-target, since the label forwards it.
 */
export async function isClickActionable(
	handle: ElementHandle,
	signal?: AbortSignal,
	options: Pick<ClickAtOptions, "button"> = {},
): Promise<ActionabilityResult> {
	const flags: ClickFlags = { viaLabel: (options.button ?? "left") === "left" };
	return await untilAborted(signal, () => handle.evaluate(clickActionableInPage, flags));
}

async function actionableClickPoint(
	handle: ElementHandle,
	label: string,
	signal: AbortSignal | undefined,
	options: ClickAtOptions,
): Promise<ClickPoint> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const element = el as unknown as PageElement;
			element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
		}),
	);
	let previous = await untilAborted(signal, () => handle.boundingBox());
	let refusal: string | undefined;
	try {
		while (true) {
			throwIfAborted(signal);
			await untilAborted(signal, () => Bun.sleep(16));
			const current = await untilAborted(signal, () => handle.boundingBox());
			const stable =
				previous !== null &&
				current !== null &&
				Math.abs(previous.x - current.x) < 0.5 &&
				Math.abs(previous.y - current.y) < 0.5 &&
				Math.abs(previous.width - current.width) < 0.5 &&
				Math.abs(previous.height - current.height) < 0.5;
			const result = await isClickActionable(handle, signal, options);
			// ElementHandle.boundingBox() is relative to the main frame; elementFromPoint() above is frame-local.
			if (stable && result.ok && current) return { x: current.x + result.x, y: current.y + result.y };
			if (stable && !result.ok && result.coveredBy) {
				throw new ToolError(`${label} blocked: covered by ${result.coveredBy}`);
			}
			refusal = result.ok ? "still moving" : result.coveredBy ? `covered by ${result.coveredBy}` : result.reason;
			previous = current;
			await untilAborted(signal, () => Bun.sleep(34));
		}
	} catch (error) {
		if (signal?.aborted && refusal !== undefined) throw new ClickRefusedError(refusal, { cause: signal.reason });
		throw error;
	}
}

/**
 * Click an element only after verifying the dispatched point is not occluded, then confirm the browser
 * delivered the click to it: the target got the `mousedown` or `click` (a label's forwarded `click` counts
 * for its control), or the page consumed its `pointerdown` with `preventDefault()`, which suppresses the
 * mouse events after it. A disabled control gets only an unconsumed `pointerdown` and an inert subtree
 * nothing, so a click the page never saw fails instead of reporting success.
 */
export async function clickElement(
	handle: ElementHandle,
	label: string,
	signal?: AbortSignal,
	options: ClickAtOptions = {},
): Promise<void> {
	const point = await actionableClickPoint(handle, label, signal, options);
	const watch = await untilAborted(signal, () =>
		handle.evaluateHandle(el => {
			interface InputEvent {
				type: string;
				defaultPrevented: boolean;
				composedPath(): unknown[];
			}
			type Listen = (type: string, listener: (event: InputEvent) => void, capture: boolean) => void;
			const target = el as unknown as { addEventListener: Listen; removeEventListener: Listen };
			const page = globalThis as unknown as { addEventListener: Listen; removeEventListener: Listen };
			const pointerDowns: InputEvent[] = [];
			const state = {
				reached: false,
				// Read after the click: the page's handlers have run by then.
				delivered: () => state.reached || pointerDowns.some(event => event.defaultPrevented),
				stop: () => {},
			};
			const record = (event: InputEvent) => {
				if (event.type === "pointerdown") pointerDowns.push(event);
				else state.reached = true;
			};
			// The target's own listener sees events inside a closed shadow root, which the window's path hides;
			// the window's sees an event a page handler stops before it reaches the target.
			const onPage = (event: InputEvent) => {
				if (event.composedPath().includes(el)) record(event);
			};
			const types = ["pointerdown", "mousedown", "click"];
			for (const type of types) {
				target.addEventListener(type, record, true);
				page.addEventListener(type, onPage, true);
			}
			state.stop = () => {
				for (const type of types) {
					target.removeEventListener(type, record, true);
					page.removeEventListener(type, onPage, true);
				}
			};
			return state;
		}),
	);
	try {
		await clickPoint(handle.frame.page(), point.x, point.y, options, signal);
	} catch (error) {
		// The page may be stuck; tidy up without waiting on it.
		void watch
			.evaluate(state => state.stop())
			.catch(() => undefined)
			.finally(() => watch.dispose().catch(() => undefined));
		throw error;
	}
	// A click that navigated away took the page's record with it; it reached the page. A cancelled call
	// still fails as cancelled.
	const delivered = await untilAborted(signal, () =>
		watch.evaluate(state => {
			state.stop();
			return state.delivered();
		}),
	).catch((error: unknown) => {
		if (signal?.aborted) throw error;
		return true;
	});
	await watch.dispose().catch(() => undefined);
	if (!delivered) {
		throw new ToolError(`${label}: the browser did not deliver the click to the element (disabled or inert)`);
	}
}

/**
 * Focus a text-entry target, refusing one that cannot take keystrokes. A
 * disabled control ignores `focus()`, so they would land in whichever element
 * had focus; a read-only one drops them. The check runs after `focus()` so a
 * focus handler that locks the field is seen.
 */
async function focusTextEntryTarget(
	handle: ElementHandle,
	action: "fill" | "type into",
	signal?: AbortSignal,
): Promise<void> {
	const refusal = await untilAborted(signal, () =>
		handle.evaluate((el, replacing) => {
			const node = el as unknown as {
				readOnly?: boolean;
				isContentEditable?: boolean;
				focus?: () => void;
				matches(selector: string): boolean;
				ownerDocument: {
					createRange(): { selectNodeContents(node: unknown): void };
					getSelection(): { removeAllRanges(): void; addRange(range: unknown): void } | null;
				};
			};
			// Focusing a contenteditable puts the caret at its start, which an editor syncs into its own state
			// and may apply back to the page a task later (Slate renders it), over the selection fill makes. A
			// fill selects the contents first, so focusing keeps them selected and the editor syncs that.
			if (replacing && node.isContentEditable) {
				const range = node.ownerDocument.createRange();
				range.selectNodeContents(node);
				const selection = node.ownerDocument.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
			}
			if (replacing && node.matches("select"))
				throw new Error("tab.fill() does not support <select>; use tab.select() instead");
			node.focus?.();
			if (node.matches(":disabled")) return "disabled";
			if (node.readOnly) return "read-only";
			return null;
		}, action === "fill"),
	);
	if (refusal) throw new ToolError(`Cannot ${action} a ${refusal} element`);
}

/**
 * Type into the focused element one code point at a time, checking `signal` before each key.
 * Puppeteer's `keyboard.type()` cannot be cancelled, so awaiting it whole under a deadline would leave
 * the rest of the text typing behind a rejected call.
 *
 * @throws TypingInterruptedError when `signal` aborts after at least one key was sent.
 */
async function typeKeys(
	page: Page,
	text: string,
	signal: AbortSignal | undefined,
	options?: Readonly<KeyboardTypeOptions>,
): Promise<void> {
	const characters = Array.from(text);
	let typed = 0;
	try {
		for (const character of characters) {
			throwIfAborted(signal);
			await untilAborted(signal, () => page.keyboard.type(character, options));
			typed++;
		}
	} catch (error) {
		if (signal?.aborted && typed > 0) {
			throw new TypingInterruptedError(
				`typing stopped after ${typed} of ${characters.length} characters (the field keeps what was typed)`,
				{ cause: signal.reason },
			);
		}
		throw error;
	}
}

/** Focus a text-entry target, then type `text` so an abort stops before the next key; see {@link typeKeys}. */
export async function typeIntoElement(
	handle: ElementHandle,
	text: string,
	signal?: AbortSignal,
	options?: Readonly<KeyboardTypeOptions>,
): Promise<void> {
	await focusTextEntryTarget(handle, "type into", signal);
	await typeKeys(handle.frame.page(), text, signal, options);
}

/**
 * Input types set through a picker or slider, with an example of the value each takes. Typing into
 * one fills its segments by keystroke rules (`2026-10-12` became `61012-02-02`) or nothing at all
 * (a colour stayed `#000000`, a range at its midpoint), so fill sets their value instead.
 */
const PICKER_VALUE_EXAMPLES: Record<string, string> = {
	color: '"#ff8800"',
	date: '"2026-10-12"',
	"datetime-local": '"2026-10-12T14:30"',
	month: '"2026-10"',
	time: '"14:30"',
	week: '"2026-W41"',
	range: "a number within its min, max and step",
};
const PICKER_INPUT_TYPES = Object.keys(PICKER_VALUE_EXAMPLES);

/**
 * Focus a field that can take text, clear any existing value, then retype. A colour, date, time or
 * range input gets its value set the way its picker would, and refuses one it rejects. A
 * contenteditable element has its contents selected and replaced by one text insertion (or deleted
 * by Backspace for an empty value), as a paste would.
 *
 * Every step is a DOM evaluation or an input dispatch, so this works on tabs
 * that produce no animation frames — unlike Puppeteer's `Locator.fill`, whose
 * viewport/stability/enabled preconditions wait on `requestAnimationFrame`
 * and `IntersectionObserver` callbacks that a backgrounded headless tab never
 * delivers (#12892). Typing stops at the next key once `signal` aborts.
 */
export async function fillViaHandle(handle: ElementHandle, value: string, signal?: AbortSignal): Promise<void> {
	await focusTextEntryTarget(handle, "fill", signal);
	const prepared = await untilAborted(signal, () =>
		handle.evaluate(
			(el, wanted, pickerTypes) => {
				const node = el as unknown as {
					localName?: string;
					type?: string;
					value?: string;
					focus?: () => void;
					isContentEditable?: boolean;
					parentElement: EditableAncestor | null;
					getRootNode(): { activeElement: { contains(other: unknown): boolean } | null };
					contains(other: unknown): boolean;
					getAttribute(name: string): string | null;
					namespaceURI: string | null;
					ownerDocument: {
						createElementNS(
							namespace: string | null,
							tag: "input",
						): { value: string; setAttribute(name: string, value: string): void };
						createRange(): {
							readonly collapsed: boolean;
							selectNodeContents(node: unknown): void;
							getClientRects(): ArrayLike<{ width: number; height: number }>;
						};
						getSelection(): { removeAllRanges(): void; addRange(range: unknown): void } | null;
					};
					dispatchEvent(event: unknown): boolean;
				};
				node.focus?.();
				// The native setter bypasses value trackers that frameworks (React) install on the element, so
				// they see the new value as a change instead of their own write. It is looked up past the
				// prototypes of a customized built-in (`<input is=…>`), which do not own `value`. A page class
				// that defines its own `value` accessor is not on the chain this function sees, so that accessor
				// never runs here.
				let proto = Object.getPrototypeOf(node);
				let descriptor: PropertyDescriptor | undefined;
				while (proto) {
					descriptor = Object.getOwnPropertyDescriptor(proto, "value");
					if (descriptor) break;
					proto = Object.getPrototypeOf(proto);
				}
				const setValue = descriptor?.set;
				const write = (next: string): void => {
					if (setValue) setValue.call(node, next);
					else node.value = next;
				};
				// Like the browser's own, input leaves a shadow root and change stays inside it.
				const report = () => {
					const { Event } = globalThis as unknown as PageGlobals;
					node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
					node.dispatchEvent(new Event("change", { bubbles: true }));
				};
				const kind = node.type?.toLowerCase() ?? "";
				// localName, not tagName: an XHTML page keeps the tag's lower case.
				if (node.localName === "input" && pickerTypes.includes(kind)) {
					const before = node.value ?? "";
					// Tried on a plain input with the same type, min, max and step: a value written to the live
					// control and then put back would still cut it off from its value attribute, and a copy of a
					// customized built-in would run the page's constructor. It takes the target's namespace, which
					// an XML document's createElement would drop for a generic element that keeps any value.
					const probe = node.ownerDocument.createElementNS(node.namespaceURI, "input");
					for (const name of ["type", "min", "max", "step"]) {
						const attribute = node.getAttribute(name);
						if (attribute !== null) probe.setAttribute(name, attribute);
					}
					probe.value = wanted;
					// The browser normalises what it accepts (a colour to #rrggbb, a time's seconds), turns what
					// it rejects into "" (a colour into #000000, a range into its midpoint) and clamps a range. A
					// colour stored as #000000 is accepted only if it draws black, so the browser resolves it rather
					// than a parser saying it is well-formed (`var(--missing)` is, and is still refused). A
					// rejected range number can land on the midpoint it coerces to (`0x5`), so its spelling is
					// checked against the decimal form the browser parses. Only the date and time types can be
					// cleared.
					const actual = probe.value;
					let refused: boolean;
					if (kind === "color") {
						const { OffscreenCanvas } = globalThis as unknown as {
							OffscreenCanvas: new (
								width: number,
								height: number,
							) => {
								getContext(type: "2d"): {
									fillStyle: string;
									fillRect(x: number, y: number, width: number, height: number): void;
									getImageData(
										x: number,
										y: number,
										width: number,
										height: number,
									): { data: ArrayLike<number> };
								} | null;
							};
						};
						// A colour the canvas cannot parse keeps the white set first, so it draws white.
						const paint = new OffscreenCanvas(1, 1).getContext("2d");
						let drawsBlack = false;
						if (paint) {
							paint.fillStyle = "#ffffff";
							paint.fillStyle = wanted;
							paint.fillRect(0, 0, 1, 1);
							const [red, green, blue] = Array.from(paint.getImageData(0, 0, 1, 1).data);
							drawsBlack = red === 0 && green === 0 && blue === 0;
						}
						refused = actual === "#000000" && !drawsBlack;
					} else if (kind === "range") {
						refused =
							!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(wanted) || Number(actual) !== Number(wanted);
					} else {
						refused = wanted !== "" && actual === "";
					}
					// A picker reports a pick that changes the value, not one that keeps it.
					if (!refused && actual !== before) {
						write(wanted);
						report();
					}
					return { target: "picker" as const, kind, refused };
				}
				if (node.isContentEditable) {
					// An element inside an editing host is usually not focusable, so its host is focused. Input goes to
					// whatever holds focus, so focus has to end on the host or on an element between it and the target;
					// a host whose focus handler moved it elsewhere (or an inert one, which leaves it on the body) would
					// have the replacement land outside it. The element's own root (its document, or a shadow root,
					// closed ones included) says which of its elements holds focus.
					let host: EditableAncestor | null = node.parentElement?.isContentEditable ? node.parentElement : null;
					while (host?.parentElement?.isContentEditable) host = host.parentElement;
					host?.focus();
					const active = node.getRootNode().activeElement;
					if (!active?.contains(node) || !(host ?? node).contains(active)) return { target: "unfocused" as const };
					// Rich-text editors (Slate, Lexical) keep their own document and either undo a direct DOM write
					// or stop tracking the element, so the old text is selected for the input that replaces it.
					const range = node.ownerDocument.createRange();
					range.selectNodeContents(node);
					const selection = node.ownerDocument.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
					// The browser keeps a deletion inside the editing host, so a host with any contents is cleared.
					// Inside a host, Backspace over contents that draw nothing deletes the character before them, so
					// an element there is cleared only when its contents draw something (text, an image).
					const deletable = node.parentElement?.isContentEditable
						? Array.from(range.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)
						: !range.collapsed;
					return { target: "editable" as const, deletable };
				}
				const before = node.value;
				if ("value" in node) write("");
				// Typing a value fires its own input events; an empty value types nothing,
				// so report the clear itself when there was something to clear.
				if (wanted === "" && before) report();
				return { target: "field" as const };
			},
			value,
			PICKER_INPUT_TYPES,
		),
	);
	const page = handle.frame.page();
	switch (prepared.target) {
		case "picker":
			if (prepared.refused) {
				throw new ToolError(
					`<input type=${prepared.kind}> does not accept ${JSON.stringify(value)}; give its value format, e.g. ${PICKER_VALUE_EXAMPLES[prepared.kind]}`,
				);
			}
			return;
		case "unfocused":
			throw new ToolError("Cannot fill an element that does not keep focus");
		case "editable":
			if (!value && !prepared.deletable) return;
			throwIfAborted(signal);
			try {
				// One `Input.insertText` replaces the selection the way a paste does; the editor's own
				// beforeinput handling applies it to its model. Backspace is a real deletion of the selection.
				await untilAborted(signal, () =>
					value ? page.keyboard.sendCharacter(value) : page.keyboard.press("Backspace"),
				);
			} catch (error) {
				// The input was already sent and cannot be recalled, so the editor may hold its result.
				if (signal?.aborted) {
					throw new TypingInterruptedError(
						`the ${value ? "replacement text" : "deletion"} was already sent and may have reached the editor`,
						{ cause: signal.reason },
					);
				}
				throw error;
			}
			return;
		case "field":
			await typeKeys(page, value, signal);
	}
}

interface QueryCandidate {
	handle: ElementHandle;
	/** Document coordinates, so candidates measured at different scroll offsets still compare. */
	x: number;
	y: number;
	onScreen: boolean;
	/** Shown only as a strip at an edge; see {@link MeasuredBox.edgeOnly}. */
	edgeOnly: boolean;
	owned: boolean;
}

async function disposeOwned(candidates: Iterable<QueryCandidate>): Promise<void> {
	for (const candidate of candidates) {
		if (candidate.owned) await candidate.handle.dispose().catch(() => undefined);
	}
}

interface MeasuredBox {
	x: number;
	y: number;
	sized: boolean;
	onScreen: boolean;
	/** Missed by every interior probe but hit half a pixel inside an edge, as a strip a scroll container leaves in view is. */
	edgeOnly: boolean;
}

/**
 * Runs in the page: the element's document position, whether it has a box, and whether the browser shows
 * it anywhere in the viewport. Visibility is the renderer's own hit test at a few points of each on-screen
 * fragment, landing on the element or inside it, so every clip, transform, top layer and containment rule
 * is the browser's. An element hit testing cannot see (`pointer-events: none`, `visibility: hidden`, inert)
 * is not shown.
 * Self-contained, since Puppeteer serializes it.
 */
function measureBoxInPage(el: unknown): MeasuredBox {
	const element = el as unknown as PageElement;
	const page = globalThis as unknown as PageGlobals & { scrollX: number; scrollY: number };
	const rect = element.getBoundingClientRect();
	const inViewport = (r: PageRect) => ({
		left: Math.max(0, r.left),
		top: Math.max(0, r.top),
		right: Math.min(page.innerWidth, r.right),
		bottom: Math.min(page.innerHeight, r.bottom),
	});
	const shown = Array.from(element.getClientRects())
		.map(inViewport)
		.filter(r => r.right - r.left >= 1 && r.bottom - r.top >= 1);
	const style = page.getComputedStyle(element);
	const hitTestable =
		style.pointerEvents !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
	const hitsElement = (x: number, y: number): boolean => {
		let hit = page.document.elementFromPoint(x, y);
		for (let depth = 0; hit?.shadowRoot && depth < 16; depth++) {
			const nested = hit.shadowRoot.elementFromPoint(x, y);
			if (!nested || nested === hit) break;
			hit = nested;
		}
		for (let node = hit; node; node = node.assignedSlot ?? node.parentElement ?? node.getRootNode().host ?? null) {
			if (node === element) return true;
		}
		return false;
	};
	// The resolver still falls back to a match that is not shown, so the click's actionability check says why.
	const hitAny = (points: (r: { left: number; right: number; top: number; bottom: number }) => number[][]) =>
		hitTestable && shown.some(r => points(r).some(([x, y]) => hitsElement(x, y)));
	const grid = (xs: number[], ys: number[]) => xs.flatMap(x => ys.map(y => [x, y]));
	const interior = (start: number, end: number) => [0.5, 0.15, 0.85].map(f => start + (end - start) * f);
	const onScreen = hitAny(r => grid(interior(r.left, r.right), interior(r.top, r.bottom)));
	// Every shown rect is at least 1px on each axis, so half a pixel in stays inside it.
	const edgeOnly =
		!onScreen &&
		hitAny(r => {
			const xs = interior(r.left, r.right);
			const ys = interior(r.top, r.bottom);
			const edgeXs = [r.left + 0.5, r.right - 0.5];
			const edgeYs = [r.top + 0.5, r.bottom - 0.5];
			return [...grid(edgeXs, [...ys, ...edgeYs]), ...grid(xs, edgeYs)];
		});
	return {
		x: rect.left + page.scrollX,
		y: rect.top + page.scrollY,
		sized: rect.width >= 1 && rect.height >= 1,
		onScreen,
		edgeOnly,
	};
}

/**
 * Lift a text match to its clickable ancestor and measure it, or return null for a match with no box.
 * `isIntersectingViewport` waits on an `IntersectionObserver` callback that background tabs never
 * deliver, so visibility comes from {@link measureBoxInPage}'s synchronous hit test instead.
 */
async function measureQueryCandidate(handle: ElementHandle, signal?: AbortSignal): Promise<QueryCandidate | null> {
	let candidate = handle;
	let owned = false;
	try {
		const proxy = await untilAborted(signal, () =>
			handle.evaluateHandle(el =>
				(el as Element).closest('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]'),
			),
		);
		const element = proxy.asElement();
		if (element) {
			candidate = element;
			owned = candidate !== handle;
		} else await proxy.dispose();
		const box = await untilAborted(signal, () => candidate.evaluate(measureBoxInPage));
		if (box.sized) {
			return { handle: candidate, x: box.x, y: box.y, onScreen: box.onScreen, edgeOnly: box.edgeOnly, owned };
		}
	} catch (error) {
		if (owned) await candidate.dispose().catch(() => undefined);
		if (signal?.aborted) throw error;
		return null;
	}
	if (owned) await candidate.dispose().catch(() => undefined);
	return null;
}

/**
 * Scroll an off-screen match into view: `shown` when the browser's hit test finds it there, `reachable`
 * when the actionability check would let a click go at it (it also accepts a hit on an ancestor, which is
 * what a clipped or inert match yields) or names what covers it.
 */
async function probeOffScreen(
	handle: ElementHandle,
	signal?: AbortSignal,
): Promise<{ shown: boolean; reachable: boolean }> {
	try {
		await untilAborted(signal, () =>
			handle.evaluate(el => {
				const element = el as unknown as PageElement;
				element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
			}),
		);
		const actionable = await isClickActionable(handle, signal);
		const reachable = actionable.ok || actionable.coveredBy !== undefined;
		if (!actionable.ok) return { shown: false, reachable };
		const box = await untilAborted(signal, () => handle.evaluate(measureBoxInPage));
		return { shown: box.onScreen, reachable };
	} catch (error) {
		if (signal?.aborted) throw error;
		return { shown: false, reachable: false };
	}
}

/**
 * Resolve text-query matches to the first match the browser shows on screen, in document order. A match
 * shown only as a strip at an edge counts once scrolling it into view lets the browser hit its interior,
 * as with a strip a scroll container leaves; one an overlay covers stays covered there. When none is on
 * screen, off-screen matches are scrolled into view in document order and the first one shown wins;
 * failing that, the first one a click could be aimed at, then the first match, so the click itself reports
 * what stops it.
 */
export async function resolveActionableQueryHandlerClickTarget(
	handles: ElementHandle[],
	signal?: AbortSignal,
): Promise<ElementHandle | null> {
	const candidates: QueryCandidate[] = [];
	let winner: QueryCandidate | undefined;
	try {
		for (const handle of handles) {
			const candidate = await measureQueryCandidate(handle, signal);
			if (candidate) candidates.push(candidate);
		}
		candidates.sort((a, b) => a.y - b.y || a.x - b.x);
		for (const candidate of candidates) {
			if (candidate.onScreen || (candidate.edgeOnly && (await probeOffScreen(candidate.handle, signal)).shown)) {
				winner = candidate;
				break;
			}
		}
		if (!winner) {
			let reachable: QueryCandidate | undefined;
			for (const candidate of candidates) {
				const probe = await probeOffScreen(candidate.handle, signal);
				if (probe.shown) {
					winner = candidate;
					break;
				}
				if (probe.reachable) reachable ??= candidate;
			}
			winner ??= reachable ?? candidates[0];
		}
	} catch (error) {
		await disposeOwned(candidates);
		throw error;
	}
	await disposeOwned(candidates.filter(candidate => candidate !== winner));
	return winner?.handle ?? null;
}

interface UploadInfo {
	name: string;
	type: string;
	lastModified: number;
}

/** Stream file bytes to browsers which cannot read the session host's paths. */
export async function uploadFileContents(
	handle: ElementHandle,
	absolutePaths: string[],
	signal?: AbortSignal,
): Promise<void> {
	if (!absolutePaths.length) throw new ToolError("uploadFile() requires at least one file path");
	const validate = (element: unknown, count: number): string | null => {
		const input = element as { localName: string; type: string; multiple: boolean };
		if (input.localName !== "input" || input.type.toLowerCase() !== "file")
			return "uploadFile() requires an <input type=file> element";
		return count > 1 && !input.multiple ? "Multiple file uploads require <input type=file multiple>" : null;
	};
	const refusal = await untilAborted(signal, () => handle.evaluate(validate, absolutePaths.length));
	if (refusal) throw new ToolError(refusal);
	const creating = handle.evaluateHandle(() => [] as Uint8Array[][]);
	const parts = await untilAbortedOrReleased(signal, creating, late => late.dispose());
	try {
		const infos: UploadInfo[] = [];
		for (const [index, absolute] of absolutePaths.entries()) {
			throwIfAborted(signal);
			const source = await fs.promises.open(absolute, "r");
			try {
				const stat = await source.stat();
				if (!stat.isFile()) throw new ToolError(`Content uploads require a regular file: ${absolute}`);
				const type = Bun.file(absolute).type.split(";", 1)[0] ?? "";
				infos.push({
					name: path.basename(absolute),
					type: type === "application/octet-stream" ? "" : type,
					lastModified: Math.trunc(stat.mtimeMs),
				});
				const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
				let sequence = 0;
				for (;;) {
					throwIfAborted(signal);
					const { bytesRead } = await source.read(buffer);
					if (!bytesRead) break;
					const encoded = buffer.subarray(0, bytesRead).toBase64();
					await untilAborted(signal, () =>
						parts.evaluate(
							(chunks, fileIndex, seq, data) => {
								const fileChunks = chunks[fileIndex] ?? [];
								chunks[fileIndex] = fileChunks;
								fileChunks[seq] = Uint8Array.from(atob(data), character => character.charCodeAt(0));
							},
							index,
							sequence++,
							encoded,
						),
					);
				}
			} finally {
				await source.close();
			}
		}
		throwIfAborted(signal);
		const finalRefusal = await untilAborted(signal, () =>
			handle.evaluate(
				(element, chunks, files) => {
					const input = element as unknown as {
						localName: string;
						type: string;
						multiple: boolean;
						files: unknown;
						dispatchEvent(event: unknown): boolean;
					};
					if (input.localName !== "input" || input.type.toLowerCase() !== "file")
						return "uploadFile() target is no longer a file input";
					if (files.length > 1 && !input.multiple)
						return "Multiple file uploads require <input type=file multiple>";
					const page = globalThis as unknown as PageGlobals;
					const transfer = new page.DataTransfer();
					for (const [index, info] of files.entries())
						transfer.items.add(
							new page.File(chunks[index] ?? [], info.name, {
								type: info.type,
								lastModified: info.lastModified,
							}),
						);
					input.files = transfer.files;
					input.dispatchEvent(new page.Event("input", { bubbles: true, composed: true }));
					input.dispatchEvent(new page.Event("change", { bubbles: true }));
					return null;
				},
				parts,
				infos,
			),
		);
		if (finalRefusal) throw new ToolError(finalRefusal);
	} finally {
		void parts.dispose().catch(() => undefined);
	}
}

export async function selectElementOptions(
	handle: ElementHandle,
	values: string[],
	label: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const outcome = (await untilAborted(signal, () =>
		handle.evaluate((el, vals) => {
			interface SelectOption {
				value: string;
				label: string;
				text: string;
				index: number;
				selected: boolean;
			}
			interface SelectLike {
				tagName: string;
				multiple: boolean;
				selectedIndex: number;
				options: ArrayLike<SelectOption>;
				dispatchEvent: (event: unknown) => boolean;
			}
			const select = el as unknown as SelectLike;
			if (select?.tagName !== "SELECT") return null;
			const page = globalThis as unknown as PageGlobals;
			const options = Array.from(select.options);
			const wanted: SelectOption[] = [];
			const missing: string[] = [];
			for (const value of vals as string[]) {
				const option =
					options.find(candidate => candidate.value === value) ??
					options.find(
						candidate => candidate.label === value || candidate.text.replace(/\s+/g, " ").trim() === value,
					);
				if (option) wanted.push(option);
				else missing.push(value);
			}
			if (missing.length > 0) return { missing };
			let selected: string[];
			if (wanted.length === 0) {
				for (const option of options) option.selected = false;
				selected = [];
			} else if (select.multiple) {
				for (const option of options) option.selected = wanted.includes(option);
				selected = options.filter(option => option.selected).map(option => option.value);
			} else {
				select.selectedIndex = wanted[0]!.index;
				selected = [wanted[0]!.value];
			}
			select.dispatchEvent(new page.Event("input", { bubbles: true }));
			select.dispatchEvent(new page.Event("change", { bubbles: true }));
			return { selected };
		}, values),
	)) as { missing: string[] } | { selected: string[] } | null;
	if (!outcome) throw new ToolError(`${label} requires a <select> element`);
	if ("missing" in outcome)
		throw new ToolError(
			`No <select> option matches ${outcome.missing.map(value => JSON.stringify(value)).join(", ")}`,
		);
	return outcome.selected;
}

function trackPress(press: Promise<void>): { press: Promise<void>; refused: boolean } {
	const tracked = { press, refused: false };
	press.catch(() => {
		tracked.refused = true;
	});
	return tracked;
}

/**
 * Release keys in order. Each release is awaited and one that fails does not stop the rest; once `signal` aborts,
 * every release still owed is sent at once and not awaited: Chrome keeps input in order, and the page the call
 * gave up on may not answer before this worker is replaced. The first failure, or the abort, is thrown once every
 * release went out.
 */
async function releaseKeys(page: Page, keys: readonly KeyInput[], signal?: AbortSignal): Promise<void> {
	let failure: { error: unknown } | undefined;
	for (const [index, key] of keys.entries()) {
		if (signal?.aborted) {
			for (const owed of keys.slice(index)) void page.keyboard.up(owed).catch(() => {});
			break;
		}
		try {
			await untilAborted(signal, () => page.keyboard.up(key));
		} catch (error) {
			failure ??= { error };
		}
	}
	if (failure) throw failure.error;
	throwIfAborted(signal);
}

/**
 * Where a cancelled press is released: off the page, so the press drops no drag (unless the page captured the
 * pointer), at a point no real pointer reports, so {@link CANCELLED_RELEASE_GUARD} can tell the release apart.
 */
const CANCELLED_RELEASE_POINT = -7919;

/**
 * Swallows the `click`/`auxclick` Chrome fires on the document root for a release at
 * {@link CANCELLED_RELEASE_POINT}: Chrome completes a click on the common ancestor of the press and release
 * targets whatever CDP says, and a page's "click outside" handler would take it as the user's. Installed at
 * document start, its capture listeners run before the page's. Chrome dispatches that click in the same task
 * as the release, so the mark lapses with the task: a keyboard click later is never swallowed. One install per
 * document, however many workers attach.
 */
const CANCELLED_RELEASE_GUARD = `(() => {
	const installed = Symbol.for("proto.cancelledReleaseGuard");
	if (globalThis[installed]) return;
	Object.defineProperty(globalThis, installed, { value: true });
	let cancelled = false;
	addEventListener("mouseup", event => {
		if (event.clientX !== ${CANCELLED_RELEASE_POINT} || event.clientY !== ${CANCELLED_RELEASE_POINT}) return;
		cancelled = true;
		setTimeout(() => { cancelled = false; });
	}, true);
	const swallow = event => {
		if (!cancelled) return;
		cancelled = false;
		event.stopImmediatePropagation();
		event.preventDefault();
	};
	addEventListener("click", swallow, true);
	addEventListener("auxclick", swallow, true);
})();`;

/** Install {@link CANCELLED_RELEASE_GUARD} in this page's documents, current and future. */
export async function installCancelledReleaseGuard(page: Page): Promise<void> {
	await page.evaluateOnNewDocument(CANCELLED_RELEASE_GUARD);
	await page
		.mainFrame()
		.mainRealm()
		.evaluate(CANCELLED_RELEASE_GUARD)
		.catch(() => undefined);
}

/**
 * Release a mouse button off the page so the press activates nothing it pressed: the page gets its `mouseup`,
 * and the click Chrome then fires on the document root is swallowed (see {@link CANCELLED_RELEASE_GUARD}). Sent
 * at once and not awaited, for the same reason as {@link releaseKeys}.
 */
export function releaseButtonOffPage(page: Page, options: MouseButtonOptions): void {
	void page.mouse.move(CANCELLED_RELEASE_POINT, CANCELLED_RELEASE_POINT).catch(() => {});
	void page.mouse.up(options).catch(() => {});
}

/**
 * macOS runs editing shortcuts as app-menu commands a CDP key event never reaches, so the key-down
 * names Chrome's editor command instead; elsewhere the plain key event already edits.
 * Keyed by the sorted Tern modifiers and the lower-cased letter.
 */
const EDITING_COMMANDS: Readonly<Record<string, string>> =
	process.platform === "darwin"
		? {
				"meta+a": "selectAll",
				"meta+c": "copy",
				"meta+v": "paste",
				"meta+x": "cut",
				"meta+z": "undo",
				"meta+shift+z": "redo",
			}
		: {};

/** The editor command a combo names on macOS, whatever its spelling (`Meta+c`, `MetaLeft+KeyC`, `Shift+Meta+Z`). */
function editingCommand(keys: readonly string[]): string | undefined {
	const key = keys[keys.length - 1]!;
	if (keys.length < 2 || !/^(?:Key[A-Z]|[A-Za-z])$/.test(key)) return undefined;
	const modifiers = new Set<string>();
	for (const name of keys.slice(0, -1)) {
		// ternKey throws on names Tern cannot type; only modifiers can select a command.
		const modifier = /^(?:Shift|Control|Alt|Meta)(?:Left|Right)?$/.test(name)
			? name.replace(/(?:Left|Right)$/, "").toLowerCase()
			: undefined;
		if (!modifier) return undefined;
		modifiers.add(modifier);
	}
	return EDITING_COMMANDS[`${[...modifiers].sort().join("+")}+${key.replace(/^Key/, "").toLowerCase()}`];
}

/**
 * Press a key or a `+`-joined combo (`Enter`, `Shift+Tab`, `Meta+a`): the leading
 * keys go down in order, the last key is pressed with `options`, then all of them
 * are released in reverse. An aborted press sends no further key down and still
 * releases each key whose press went out, so no modifier stays held for the user's
 * next key.
 */
export async function pressKey(
	page: Page,
	combo: string,
	options?: KeyPressOptions,
	signal?: AbortSignal,
): Promise<void> {
	// Unchecked on purpose: puppeteer validates each name and throws `Unknown key: "…"`.
	const parts = combo.length <= 1 || !combo.includes("+") ? [combo] : combo.split("+");
	if (parts.length > 1 && parts.at(-1) === "") {
		parts.pop();
		parts[parts.length - 1] = "+";
	}
	const keys = parts.filter(Boolean) as KeyInput[];
	if (!keys.length) throw new ToolError("A key or key combo is required");
	const command = editingCommand(keys);
	const pressed: { key: KeyInput; down: { press: Promise<void>; refused: boolean } }[] = [];
	let failure: { error: unknown } | undefined;
	try {
		for (const [index, key] of keys.entries()) {
			throwIfAborted(signal);
			// `commands` is @deprecated in puppeteer but still forwarded to Input.dispatchKeyEvent,
			// and puppeteer never adds the macOS editing commands itself.
			const down = trackPress(
				index === keys.length - 1
					? page.keyboard.down(key, command ? { ...options, commands: [command] } : options)
					: page.keyboard.down(key),
			);
			pressed.push({ key, down });
			await untilAborted(signal, () => down.press);
		}
		if (options?.delay) await untilAborted(signal, () => Bun.sleep(options.delay!));
	} catch (error) {
		failure = { error };
	}
	const owed = pressed.filter(({ down }) => !down.refused).map(({ key }) => key);
	try {
		await releaseKeys(page, owed.reverse(), signal);
	} catch (error) {
		failure ??= { error };
	}
	if (failure) throw failure.error;
}

async function clickPoint(
	page: Page,
	x: number,
	y: number,
	options: ClickAtOptions,
	signal?: AbortSignal,
): Promise<void> {
	const count = options.clickCount ?? 1;
	if (!Number.isInteger(count) || count < 1) throw new ToolError("Click count must be a positive integer.");
	throwIfAborted(signal);
	// Not awaited before the press, as in puppeteer's `mouse.click`: Chrome holds a pointer move until the page's
	// next frame, which a background tab may not draw for seconds, and the press flushes it.
	const moved = page.mouse.move(x, y);
	moved.catch(() => {});
	// As puppeteer's `mouse.click`: one press per click, numbered, the last carrying `count`.
	for (let clickCount = 1; clickCount < count; clickCount++) {
		await withButtonDown(page, { button: options.button, clickCount }, signal);
	}
	await withButtonDown(page, { button: options.button, clickCount: count }, signal);
	await untilAborted(signal, () => moved);
}

/** Drag with the left button from `start` to `end`; cancellation before the final release drops off-page. */
export async function dragBetween(
	page: Page,
	start: { x: number; y: number },
	end: { x: number; y: number },
	signal?: AbortSignal,
): Promise<void> {
	await untilAborted(signal, () => page.mouse.move(start.x, start.y));
	await withButtonDown(page, {}, signal, () =>
		untilAborted(signal, () => page.mouse.move(end.x, end.y, { steps: 12 })),
	);
}

/**
 * Press a button, run `gesture` (if any) while it is held, then release it where the pointer is. Cancellation
 * before that release sends it off-page instead (see {@link releaseButtonOffPage}). Once a target release has
 * been dispatched, Chrome owns it: aborting its wait cannot recall the release or prevent a late click/drop.
 */
async function withButtonDown(
	page: Page,
	options: MouseButtonOptions & { clickCount?: number },
	signal?: AbortSignal,
	gesture?: () => Promise<unknown>,
): Promise<void> {
	throwIfAborted(signal);
	const pressed = trackPress(page.mouse.down(options));
	let done = false;
	try {
		await untilAborted(signal, () => pressed.press);
		await gesture?.();
		done = true;
	} finally {
		if (done) await untilAborted(signal, () => page.mouse.up(options));
		else if (!pressed.refused) releaseButtonOffPage(page, options);
	}
}

const REQUESTED_NAVIGATION_WAIT_MS = 2_000;
const MAIN_FRAME_POLL_MS = 50;
const MAIN_FRAME_LIFECYCLE_EVENTS = { load: "load", domcontentloaded: "DOMContentLoaded" } as const;
export function readyStateInPage(): string {
	return (globalThis as unknown as { document: { readyState: string } }).document.readyState;
}

/**
 * Whether one of our own page evaluations failed because a navigation replaced the document whose execution context
 * it targeted: the context was destroyed while the call ran, or was already gone when it arrived (Puppeteer rewrites
 * that into the first message; the relay passes Chrome's own on). Puppeteer's own waits retry on the same two.
 */
export function isNavigatedContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("Execution context was destroyed") ||
			error.message.includes("Cannot find context with specified id"))
	);
}

/**
 * Wait, at most `timeoutMs`, for a main-frame navigation in flight to replace the document and for the new document
 * to finish parsing. Returns at once when `navigating()` is false, unless `contextLost` says a navigation already
 * took the document an evaluation targeted. Returns false when the wait ran out with `navigating()` still true; a
 * wait that runs out otherwise, or a page that stops answering (a dialog), leaves the page as it is.
 */
export async function waitForMainFrameDocument(
	page: Page,
	navigating: () => boolean,
	timeoutMs: number,
	signal: AbortSignal,
	contextLost = false,
): Promise<boolean> {
	if (!contextLost && !navigating()) return true;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let remaining = deadline - Date.now();
		if (navigating()) {
			if (remaining <= 0) return false;
			await untilAborted(signal, () => Bun.sleep(Math.min(MAIN_FRAME_POLL_MS, remaining)));
			continue;
		}
		if (remaining <= 0) return true;
		let state: string;
		try {
			state = await withTimeout(
				page.evaluate(readyStateInPage),
				remaining,
				"document state probe timed out",
				signal,
			);
		} catch (error) {
			if (signal.aborted) throw error;
			if (!isNavigatedContextError(error)) return true;
			state = "loading";
		}
		remaining = deadline - Date.now();
		if (state !== "loading" && !navigating()) return true;
		if (remaining <= 0) return !navigating();
		await untilAborted(signal, () => Bun.sleep(Math.min(MAIN_FRAME_POLL_MS, remaining)));
	}
}

export async function navigateMainFrame(
	page: Page,
	waitUntil: NonNullable<WaitForOptions["waitUntil"]>,
	timeout: number,
	signal: AbortSignal | undefined,
	navigate: (options: WaitForOptions) => Promise<unknown>,
): Promise<void> {
	if (waitUntil !== "load" && waitUntil !== "domcontentloaded") {
		await untilAborted(signal, () => navigate({ waitUntil, timeout }));
		return;
	}
	const deadline = Date.now() + timeout;
	await untilAborted(signal, () => navigate({ waitUntil: [], timeout }));
	const event = MAIN_FRAME_LIFECYCLE_EVENTS[waitUntil];
	for (;;) {
		if (page.isClosed() || !page.browser().connected) throw new Error("Navigating frame was detached");
		const frame = page.mainFrame();
		if (frame.detached) throw new Error("Navigating frame was detached");
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw puppeteerTimeoutError(`Navigation timeout of ${timeout} ms exceeded`);
		if (frame._lifecycleEvents.has(event)) return;
		// The last read lands on the deadline, so an event that arrives after it is a timeout.
		await untilAborted(signal, () => Bun.sleep(Math.min(MAIN_FRAME_POLL_MS, remaining)));
	}
}

function fileUrlNavigationError(url: string, error: unknown): ToolError {
	const detail = error instanceof Error ? error.message : String(error);
	return new ToolError(
		`Unable to open ${url}: ${detail}. file:// is not reachable from the shared headless browser; ` +
			"serve the file over HTTP (for example, protolens jobs --op start --name web --application python3 --args=-m,http.server) or pass app.path for a local Chromium.",
	);
}

function redactUrlCredentials(url: string): string {
	if (!url || (!url.includes("@") && !url.includes("//"))) return url;
	try {
		const parsed = new URL(url);
		if (!parsed.username && !parsed.password) return url;
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		return url;
	}
}

class RequestInterceptionCleanupError extends ToolError {}
class NavigationTimeoutError extends ToolError {}
class RendererCrashedError extends ToolError {}
class DebuggerDetachedError extends ToolError {
	constructor(
		readonly reason: string,
		readonly when: "before-run" | "during-run",
	) {
		super(
			`Chrome detached proto from this tab (${reason}) ${when === "during-run" ? "during this call" : "before this call, so its code did not run"}`,
		);
	}
}

interface RunPageScope {
	page: Page;
	detach(): void;
	restoreInterception(): Promise<void>;
}

export function createRunPageScope(page: Page, restoreInterception: () => Promise<void>): RunPageScope {
	const handlers = new Map<unknown, Function[]>();
	/**
	 * The listener the page holds for each run-owned handler. It runs the handler with
	 * `delivering` cleared, so what the handler registers stays run-owned. One per handler,
	 * so duplicate registrations and removals keep puppeteer's own ordering.
	 */
	const listeners = new Map<Function, (...args: unknown[]) => unknown>();
	const on = page.on;
	const off = page.off;
	const once = page.once;
	const emit = page.emit;
	const setRequestInterception = page.setRequestInterception;
	const onDescriptor = Object.getOwnPropertyDescriptor(page, "on");
	const offDescriptor = Object.getOwnPropertyDescriptor(page, "off");
	const onceDescriptor = Object.getOwnPropertyDescriptor(page, "once");
	const emitDescriptor = Object.getOwnPropertyDescriptor(page, "emit");
	const removeAllDescriptor = Object.getOwnPropertyDescriptor(page, "removeAllListeners");
	const interceptionDescriptor = Object.getOwnPropertyDescriptor(page, "setRequestInterception");
	let interceptionChanged = false;
	/** Set while the page delivers an event; a listener the run added clears it while it runs. */
	let delivering = false;
	const withDelivering = <T>(value: boolean, fn: () => T): T => {
		const outer = delivering;
		delivering = value;
		try {
			return fn();
		} finally {
			delivering = outer;
		}
	};
	const listenerFor = (handler: Function): ((...args: unknown[]) => unknown) => {
		let listener = listeners.get(handler);
		if (!listener) {
			listener = (...args: unknown[]): unknown =>
				withDelivering(false, () => Reflect.apply(handler, undefined, args));
			listeners.set(handler, listener);
		}
		return listener;
	};
	const remember = (type: unknown, handler: Function): void => {
		const owned = handlers.get(type);
		if (owned) owned.push(handler);
		else handlers.set(type, [handler]);
		Reflect.apply(on, page, [type, listenerFor(handler)]);
	};
	/** Remove run-owned registrations; reports whether any matched. */
	const forget = (type: unknown, handler?: unknown): boolean => {
		const owned = handlers.get(type);
		if (!owned) return false;
		if (handler === undefined) {
			for (const registered of owned) Reflect.apply(off, page, [type, listenerFor(registered)]);
			handlers.delete(type);
			return true;
		}
		const index = owned.lastIndexOf(handler as Function);
		if (index < 0) return false;
		Reflect.apply(off, page, [type, listenerFor(owned[index])]);
		owned.splice(index, 1);
		if (owned.length === 0) handlers.delete(type);
		return true;
	};

	Object.defineProperties(page, {
		on: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				if (delivering || typeof handler !== "function") Reflect.apply(on, page, [type, handler]);
				else remember(type, handler);
				return page;
			},
		},
		once: {
			configurable: true,
			value: (type: unknown, handler: unknown): Page => {
				if (delivering || typeof handler !== "function") {
					Reflect.apply(once, page, [type, handler]);
					return page;
				}
				const wrapper = (event: unknown): void => {
					forget(type, wrapper);
					Reflect.apply(handler, page, [event]);
				};
				remember(type, wrapper);
				return page;
			},
		},
		off: {
			configurable: true,
			value: (type: unknown, handler?: unknown): Page => {
				// Puppeteer's own subscriptions unsubscribe through here too.
				if (!forget(type, handler) && handler !== undefined) Reflect.apply(off, page, [type, handler]);
				return page;
			},
		},
		emit: {
			configurable: true,
			value: (type: unknown, event?: unknown): boolean => {
				// Puppeteer defers every `request` listener to an interception action that runs after
				// `emit` returns, so each action queued during `emit` keeps the delivery it came from.
				const request = type === "request" && typeof event === "object" ? (event as HTTPRequest | null) : null;
				const enqueue = request?.enqueueInterceptAction;
				if (!request || typeof enqueue !== "function") {
					return withDelivering(true, () => Reflect.apply(emit, page, [type, event]));
				}
				const enqueueDescriptor = Object.getOwnPropertyDescriptor(request, "enqueueInterceptAction");
				Object.defineProperty(request, "enqueueInterceptAction", {
					configurable: true,
					value: (action: () => unknown): void => {
						const queued = delivering;
						Reflect.apply(enqueue, request, [() => withDelivering(queued, action)]);
					},
				});
				try {
					return withDelivering(true, () => Reflect.apply(emit, page, [type, event]));
				} finally {
					// The tab's request log keeps requests well after the run; do not let them hold this scope.
					if (enqueueDescriptor) Object.defineProperty(request, "enqueueInterceptAction", enqueueDescriptor);
					else Reflect.deleteProperty(request, "enqueueInterceptAction");
				}
			},
		},
		removeAllListeners: {
			configurable: true,
			value: (type?: unknown): Page => {
				if (type !== undefined) forget(type);
				else {
					// Map iteration tolerates deletion of the current key by forget().
					for (const ownedType of handlers.keys()) forget(ownedType);
				}
				return page;
			},
		},
		setRequestInterception: {
			configurable: true,
			value: (value: boolean): Promise<void> => {
				interceptionChanged = true;
				return Reflect.apply(setRequestInterception, page, [value]);
			},
		},
	});

	return {
		page,
		detach() {
			if (onDescriptor) Object.defineProperty(page, "on", onDescriptor);
			else Reflect.deleteProperty(page, "on");
			if (offDescriptor) Object.defineProperty(page, "off", offDescriptor);
			else Reflect.deleteProperty(page, "off");
			if (onceDescriptor) Object.defineProperty(page, "once", onceDescriptor);
			else Reflect.deleteProperty(page, "once");
			if (emitDescriptor) Object.defineProperty(page, "emit", emitDescriptor);
			else Reflect.deleteProperty(page, "emit");
			if (removeAllDescriptor) Object.defineProperty(page, "removeAllListeners", removeAllDescriptor);
			else Reflect.deleteProperty(page, "removeAllListeners");
			if (interceptionDescriptor) Object.defineProperty(page, "setRequestInterception", interceptionDescriptor);
			else Reflect.deleteProperty(page, "setRequestInterception");
			for (const [type, owned] of handlers) {
				for (const handler of owned) Reflect.apply(off, page, [type, listenerFor(handler)]);
			}
			handlers.clear();
		},
		async restoreInterception() {
			if (!interceptionChanged) return;
			try {
				await withTimeout(
					restoreInterception(),
					REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
					"Timed out restoring browser request interception",
				);
			} catch (error) {
				throw new RequestInterceptionCleanupError(
					"Failed to restore browser request interception after browser.run",
					{
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
		},
	};
}

function errorPayload(error: unknown): RunErrorPayload {
	const recoverTab = error instanceof RequestInterceptionCleanupError || undefined;
	const navigationTimeout = error instanceof NavigationTimeoutError || undefined;
	const rendererCrashed = error instanceof RendererCrashedError || undefined;
	const debuggerDetached =
		error instanceof DebuggerDetachedError ? { when: error.when, reason: error.reason } : undefined;
	if (error instanceof ToolAbortError) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: true };
	}
	if (error instanceof ToolError) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isToolError: true,
			isAbort: false,
			recoverTab,
			navigationTimeout,
			rendererCrashed,
			debuggerDetached,
		};
	}
	if (error instanceof Error) {
		return { name: error.name, message: error.message, stack: error.stack, isToolError: false, isAbort: false };
	}
	return { name: "Error", message: String(error), isToolError: false, isAbort: false };
}

function replyError(payload: RunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Tool call aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const Ctor = payload.isToolError ? ToolError : Error;
	const err = new Ctor(payload.message);
	if (payload.name) err.name = payload.name;
	if (payload.stack) err.stack = payload.stack;
	return err;
}

function privateTargetId(target: Target): string | undefined {
	const raw = target as unknown as { _targetId?: unknown };
	return typeof raw._targetId === "string" ? raw._targetId : undefined;
}

async function targetIdForTarget(target: Target): Promise<string> {
	const fastTargetId = privateTargetId(target);
	if (fastTargetId) return fastTargetId;
	const session = await target.createCDPSession();
	try {
		const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
		if (info.targetInfo?.targetId) return info.targetInfo.targetId;
		throw new ToolError("Target id unavailable from CDP target info");
	} finally {
		await session.detach().catch(() => undefined);
	}
}

async function targetIdForPage(page: Page): Promise<string> {
	return await targetIdForTarget(page.target());
}

// Creates the target directly so its id is reportable before Puppeteer's page initialization, which can wedge.
async function createTrackedHeadlessPage(
	browser: Browser,
	reportTarget: (targetId: string) => void,
	attached = false,
): Promise<Page> {
	const session = attached ? browserConnection(browser) : await browser.target().createCDPSession();
	let targetId: string;
	try {
		({ targetId } = await session.send("Target.createTarget", { url: "about:blank", background: true }));
		reportTarget(targetId);
	} finally {
		if ("detach" in session) await session.detach().catch(() => undefined);
	}
	const existing = browser.targets().find(target => privateTargetId(target) === targetId);
	const target =
		existing ??
		(await browser.waitForTarget(candidate => privateTargetId(candidate) === targetId, {
			timeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		}));
	const page = await target.page();
	if (!page) throw new ToolError(`Created headless target ${targetId} did not expose a page`);
	return page;
}

const unresponsiveFrames = new WeakMap<Frame, string>();

function frameDocumentKey(frame: Frame): string {
	return `${frame._loaderId} ${frame.url()}`;
}

/** One frame's accessibility tree; ids observed in it resolve in that frame. */
interface FrameSnapshot {
	frame: Frame;
	snapshot: SerializedAXNode;
}

/**
 * Accessibility snapshots of `frames` and their descendants, each with its frame, in frame-tree
 * order. A frame that does not answer by `deadline` is left out with its descendants, and skipped
 * by later observations until it navigates, so one dead iframe never costs the page its
 * observation. With `root`, only frames inside it are read.
 */
async function snapshotFrames(
	frames: Frame[],
	options: { interestingOnly: boolean; root: ElementHandle | null; deadline: number; signal?: AbortSignal },
): Promise<FrameSnapshot[]> {
	const snapshots = await Promise.all(
		frames.map(async (frame): Promise<FrameSnapshot[]> => {
			if (unresponsiveFrames.get(frame) === frameDocumentKey(frame)) return [];
			const deadline = AbortSignal.timeout(Math.max(0, options.deadline - Date.now()));
			const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
			let snapshot: SerializedAXNode | null;
			try {
				snapshot = await untilAborted(signal, () => snapshotFrame(frame, options));
			} catch (error) {
				if (options.signal?.aborted) throw error;
				if (deadline.aborted) unresponsiveFrames.set(frame, frameDocumentKey(frame));
				return [];
			}
			if (!snapshot) return [];
			return [{ frame, snapshot }, ...(await snapshotFrames(frame.childFrames(), { ...options, root: null }))];
		}),
	);
	return snapshots.flat();
}

async function snapshotFrame(
	frame: Frame,
	options: { interestingOnly: boolean; root: ElementHandle | null },
): Promise<SerializedAXNode | null> {
	if (options.root) {
		const owner = await frame.frameElement();
		if (!owner) return null;
		const scoped = await options.root.realm.adoptHandle(owner).finally(() => owner.dispose().catch(() => undefined));
		try {
			// The owner may sit in a web component's shadow root under `root`, where `Node.contains` stops.
			if (!(await options.root.evaluate(composedContains, scoped))) return null;
		} finally {
			await scoped.dispose().catch(() => undefined);
		}
	}
	return await frame.accessibility.snapshot({ interestingOnly: options.interestingOnly });
}

/** Where an observed element lives; `tab.id(n)` resolves it to a handle on first use. */
interface ObservedElement {
	frame: Frame;
	backendNodeId: number;
	/**
	 * Loader of the document `frame` showed when observed. Backend node ids are unique only within
	 * one renderer process, so once the frame shows another document the id may name an unrelated node.
	 */
	loaderId: string;
}

/** Whether the frame has loaded another document since `element` was observed. */
function isObservedDocumentGone(element: ObservedElement): boolean {
	return element.frame._loaderId !== element.loaderId;
}

/**
 * Resolve an observed element to a handle in its frame's main world, or null when the node is
 * gone, has left the document, or the frame no longer shows the document it was observed in (any
 * resolution failure counts as gone). Text nodes resolve to their parent.
 */
async function resolveObservedElement(observed: ObservedElement): Promise<ElementHandle | null> {
	if (isObservedDocumentGone(observed)) return null;
	let node: JSHandle;
	try {
		node = await observed.frame.mainRealm().adoptBackendNode(observed.backendNodeId);
	} catch {
		return null;
	}
	try {
		const resolved = await node.evaluateHandle(value => {
			const candidate = value as unknown as { nodeType: number; parentElement: Element | null };
			const element = (candidate.nodeType === 3 ? candidate.parentElement : value) as unknown as Element | null;
			if (!element?.isConnected) return null;
			// The document itself (the root `includeAll` lists) has no owner document.
			const owner: unknown = candidate.nodeType === 9 ? value : element.ownerDocument;
			return owner === document ? element : null;
		});
		const element = resolved.asElement();
		// The frame may have committed another document while the node resolved.
		if (element && !isObservedDocumentGone(observed)) return element as ElementHandle;
		await resolved.dispose().catch(() => undefined);
		return null;
	} catch {
		return null;
	} finally {
		await node.dispose().catch(() => undefined);
	}
}

export async function collectObservationEntries(
	core: WorkerCore,
	node: SerializedAXNode,
	entries: ObservationEntry[],
	options: { viewportOnly: boolean; includeAll: boolean; frame?: Frame; signal?: AbortSignal },
): Promise<void> {
	if (options.includeAll || isInteractiveNode(node)) {
		const observed =
			options.frame && node.backendNodeId !== undefined
				? { frame: options.frame, backendNodeId: node.backendNodeId, loaderId: options.frame._loaderId }
				: undefined;
		const handle =
			observed && !options.viewportOnly ? null : await untilAborted(options.signal, () => node.elementHandle());
		if (handle || observed) {
			let inViewport = true;
			let viewportProbeFailed = false;
			if (options.viewportOnly) {
				try {
					inViewport = handle ? await untilAborted(options.signal, () => handle.isIntersectingViewport()) : true;
				} catch (error) {
					throwIfAborted(options.signal);
					// A failed probe is not evidence of being off-screen: keep the element and say so
					// instead of dropping a real control with no diagnostic.
					viewportProbeFailed = true;
					inViewport = true;
					logger.debug("Viewport probe failed during observation", {
						role: node.role,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			if (inViewport) {
				const id = core.nextElementId();
				const states: string[] = [];
				if (viewportProbeFailed) states.push("viewport-unknown");
				if (node.disabled) states.push("disabled");
				if (node.checked !== undefined) states.push(`checked=${String(node.checked)}`);
				if (node.pressed !== undefined) states.push(`pressed=${String(node.pressed)}`);
				if (node.selected !== undefined) states.push(`selected=${String(node.selected)}`);
				if (node.expanded !== undefined) states.push(`expanded=${String(node.expanded)}`);
				if (node.required) states.push("required");
				if (node.readonly) states.push("readonly");
				if (node.multiselectable) states.push("multiselectable");
				if (node.multiline) states.push("multiline");
				if (node.modal) states.push("modal");
				if (node.focused) states.push("focused");
				if (observed) core.cacheObservedElement(id, observed);
				if (handle) core.cacheElement(id, handle as ElementHandle);
				entries.push({
					id,
					role: node.role,
					name: node.name,
					value: node.value,
					description: node.description,
					keyshortcuts: node.keyshortcuts,
					states,
				});
			} else {
				void handle?.dispose().catch(() => undefined);
			}
		}
	}
	for (const child of node.children ?? []) {
		await collectObservationEntries(core, child, entries, options);
	}
}

async function queryTextSelectorAll(page: Page, text: string): Promise<ElementHandle[]> {
	const handles = (await page.$$("*")) as ElementHandle[];
	const matched: ElementHandle[] = [];
	for (const handle of handles) {
		try {
			const isMatch = (await handle.evaluate((element, needle) => {
				const node = element as unknown as {
					tagName?: string;
					textContent?: string | null;
					value?: unknown;
					closest?: (selector: string) => Element | null;
					querySelectorAll?: (selector: string) => ArrayLike<Element>;
				};
				const tagName = node.tagName?.toLowerCase();
				if (tagName === "script" || tagName === "style" || node.closest?.("head")) return false;
				const content = typeof node.value === "string" ? node.value : (node.textContent ?? "");
				if (!content.includes(needle)) return false;
				for (const child of Array.from(node.querySelectorAll?.("*") ?? [])) {
					const childNode = child as unknown as {
						tagName?: string;
						textContent?: string | null;
						value?: unknown;
						closest?: (selector: string) => Element | null;
					};
					const childTagName = childNode.tagName?.toLowerCase();
					if (
						childTagName !== "script" &&
						childTagName !== "style" &&
						!childNode.closest?.("head") &&
						(typeof childNode.value === "string" ? childNode.value : (childNode.textContent ?? "")).includes(
							needle,
						)
					)
						return false;
				}
				return true;
			}, text)) as boolean;
			if (isMatch) matched.push(handle);
			else await handle.dispose().catch(() => undefined);
		} catch {
			await handle.dispose().catch(() => undefined);
		}
	}
	return matched;
}

async function querySelectorAll(page: Page, selector: string): Promise<ElementHandle[]> {
	const normalized = normalizeSelector(selector);
	if (normalized.startsWith("text/")) return queryTextSelectorAll(page, normalized.slice("text/".length));
	return (await page.$$(normalized)) as ElementHandle[];
}

async function querySelector(page: Page, selector: string): Promise<ElementHandle | null> {
	const handles = await querySelectorAll(page, selector);
	const first = handles[0] ?? null;
	await Promise.all(handles.slice(1).map(async handle => handle.dispose().catch(() => undefined)));
	return first;
}

class ActionabilityTimeoutError extends ToolError {
	constructor(action: string, selector: string, timeoutMs: number, seen: number, reason: string) {
		super(
			`Timed out ${action} ${JSON.stringify(selector)} after ${timeoutMs}ms ` +
				`(seen ${seen} matches; last reason: ${reason})${formatSelectorMatchHint(seen)}`,
		);
	}
}

function isTimeoutAbort(reason: unknown): boolean {
	return reason instanceof Error && reason.name === "TimeoutError";
}

/** First handle that passes the actionability probe, plus the last failure reason otherwise. */
async function firstActionableHandle(
	handles: ElementHandle[],
	signal: AbortSignal,
): Promise<{ handle: ElementHandle | null; reason: string | null }> {
	let reason: string | null = null;
	for (const handle of handles) {
		try {
			const actionability = await isClickActionable(handle, signal);
			if (actionability.ok) return { handle, reason: null };
			reason = actionability.reason;
		} catch (error) {
			throwIfAborted(signal);
			reason = error instanceof Error ? error.message : String(error);
		}
	}
	return { handle: null, reason };
}

export async function waitForActionableHandle(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal: AbortSignal,
	op: "clicking" | "resolving",
	clickTarget: boolean,
): Promise<ElementHandle> {
	const deadline = Date.now() + timeoutMs;
	let lastSeen = 0;
	let lastReason = "no-matches";
	try {
		while (Date.now() < deadline) {
			throwIfAborted(signal);
			const handles = await untilAborted(signal, () => querySelectorAll(page, selector));
			lastSeen = handles.length;
			let selected: ElementHandle | null = null;
			let candidate: ElementHandle | null = null;
			try {
				if (clickTarget) {
					candidate = await resolveActionableQueryHandlerClickTarget(handles, signal);
					if (candidate) {
						const actionability = await isClickActionable(candidate, signal);
						if (actionability.ok) selected = candidate;
						else lastReason = actionability.reason;
					} else if (!handles.length) lastReason = "no-matches";
				}
				if (!selected && handles.length > 0) {
					// The click-target resolver skips anything whose viewport probe fails, so an
					// actionable match must still win instead of being reported as no candidate.
					const fallback = await firstActionableHandle(handles, signal);
					if (fallback.handle) selected = fallback.handle;
					else if (fallback.reason) lastReason = fallback.reason;
					else if (lastReason === "no-matches") lastReason = "no-visible-candidate";
				}
				if (selected) {
					for (const handle of handles) {
						if (handle !== selected) void handle.dispose().catch(() => undefined);
					}
					return selected;
				}
			} finally {
				if (candidate && candidate !== selected) void candidate.dispose().catch(() => undefined);
				if (!selected) {
					for (const handle of handles) void handle.dispose().catch(() => undefined);
				}
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await untilAborted(signal, () => Bun.sleep(Math.min(100, remaining)));
		}
	} catch (error) {
		if (Date.now() >= deadline && signal.aborted && isTimeoutAbort(signal.reason)) {
			throw new ActionabilityTimeoutError(op, selector, timeoutMs, lastSeen, lastReason);
		}
		throw error;
	}
	throw new ActionabilityTimeoutError(op, selector, timeoutMs, lastSeen, lastReason);
}

async function clickSelector(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal: AbortSignal,
	options: ClickAtOptions = {},
): Promise<void> {
	const handle = await waitForActionableHandle(page, selector, timeoutMs, signal, "clicking", true);
	try {
		await clickElement(handle, `tab.click(${JSON.stringify(selector)})`, signal, options);
	} finally {
		void handle.dispose().catch(() => undefined);
	}
}

async function clickQueryHandlerText(
	page: Page,
	selector: string,
	timeoutMs: number,
	signal?: AbortSignal,
	options: ClickAtOptions = {},
): Promise<void> {
	const clickSignal = signal ?? AbortSignal.timeout(timeoutMs);
	await clickSelector(page, selector, timeoutMs, clickSignal, options);
}

export function formatSelectorMatchHint(count: number): string {
	return count === 0
		? "; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page"
		: `; selector currently matches ${count} element(s) but the action never became possible — the element may be hidden or covered (try tab.scrollIntoView() or a more specific selector)`;
}

export interface InflightOp {
	label: string;
	startedAt: number;
}

interface ActiveRun {
	id: string;
	ac: AbortController;
	signal: AbortSignal;
	output: RunOutput;
	screenshots: ScreenshotResult[];
	pendingTools: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
	rejectionOwner: object;
	floatingRejections: unknown[];
	floatingFailure: { promise: Promise<never>; reject(reason?: unknown): void };

	inflight: Map<number, InflightOp>;
	opCounter: number;
	codeStarted: boolean;
}

/** Abort a wait without leaking a handle/session that arrives after the deadline. */
export async function untilAbortedOrReleased<T>(
	signal: AbortSignal | undefined,
	pending: Promise<T>,
	release: (late: T) => Promise<unknown>,
): Promise<T> {
	return await untilAborted(signal, () => pending).catch(error => {
		void pending.then(release).catch(() => undefined);
		throw error;
	});
}

/** Make hidden pages draw for capture, without changing the user's active tab. */
export async function whileDrawing<T>(
	page: Pick<Page, "createCDPSession">,
	signal: AbortSignal | undefined,
	capture: () => Promise<T>,
): Promise<T> {
	let session: CDPSession | undefined;
	try {
		try {
			session = await untilAbortedOrReleased(signal, page.createCDPSession(), late => late.detach());
			const screencast = session;
			await untilAborted(signal, () =>
				screencast.send("Page.startScreencast", { format: "jpeg", quality: 1, maxWidth: 1, maxHeight: 1 }),
			);
		} catch (error) {
			throwIfAborted(signal);
			logger.debug("Browser screenshot screencast unavailable; capturing without it", { error: String(error) });
		}
		throwIfAborted(signal);
		return await capture();
	} finally {
		if (session) {
			const release = session;
			await untilAborted(signal, () => release.send("Page.stopScreencast")).catch(() => undefined);
			await untilAborted(signal, () => release.detach()).catch(() => undefined);
		}
	}
}

export function describeScreenshot(opts?: ScreenshotOptions): string {
	if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
	if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
	return "tab.screenshot()";
}
export function describeInflight(inflight: Map<number, InflightOp>): string {
	const now = Date.now();
	return [...inflight.values()]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(op => `${op.label} (${((now - op.startedAt) / 1000).toFixed(1)}s)`)
		.join(", ");
}

export async function readBrowserViewport(
	page: Pick<Page, "viewport"> & Partial<Pick<Page, "evaluate">>,
	signal?: AbortSignal,
): Promise<ReadyInfo["viewport"]> {
	const emulated = page.viewport();
	if (emulated && emulated.deviceScaleFactor !== 0) return emulated;
	if (!page.evaluate) return emulated ?? DEFAULT_VIEWPORT;
	return await untilAborted(signal, () =>
		page.evaluate!(() => {
			const win = globalThis as unknown as { innerWidth: number; innerHeight: number; devicePixelRatio: number };
			return { width: win.innerWidth, height: win.innerHeight, deviceScaleFactor: win.devicePixelRatio };
		}),
	);
}

export async function collectReadyInfo(
	page: Pick<Page, "url" | "title" | "viewport"> & Partial<Pick<Page, "evaluate">>,
	targetId: string,
	options: { signal?: AbortSignal; dialogOpen?: boolean; lastViewport?: ReadyInfo["viewport"] } = {},
): Promise<ReadyInfo> {
	// Modal dialogs block Runtime.evaluate (including title), not local CDP metadata.
	const title = options.dialogOpen
		? undefined
		: await untilAborted(options.signal, () => page.title()).catch(() => undefined);
	return {
		url: redactUrlCredentials(page.url()),
		title,
		viewport: options.dialogOpen
			? (page.viewport() ?? options.lastViewport ?? DEFAULT_VIEWPORT)
			: await readBrowserViewport(page, options.signal).catch(() => options.lastViewport ?? DEFAULT_VIEWPORT),
		targetId,
	};
}

export class WorkerCore {
	#transport: Transport;
	#browser?: Browser;
	#page?: Page;
	#targetId?: string;
	#elementCache = new Map<number, ElementHandle>();
	#observedElements = new Map<number, ObservedElement>();
	#lastViewport?: ReadyInfo["viewport"];
	#elementCounter = 0;
	#active: ActiveRun | null = null;
	#runtime: JsRuntime | null = null;
	#unsub: () => void;
	#isolated: boolean;
	#uninstallRejectionGuard: () => void;
	#mode?: WorkerInitPayload["mode"];
	#ownsPage = false;
	#userDriven = false;
	#dialogPolicy?: DialogPolicy;
	#dialogHandler?: (dialog: Dialog) => void;
	#openDialog?: OpenDialogInfo;
	#pendingNavigations = new Set<HTTPRequest>();
	#mainFrameNavigationRequested = false;
	#stopped = false;
	#crashed = false;
	#started = false;
	#debuggerDetached: string | undefined;
	#unanswered: ActiveRun | null = null;
	readonly #onPageCrashed = (): void => {
		if (this.#crashed) return;
		this.#crashed = true;
		if (!this.#started) {
			this.#transport.send({
				type: "init-failed",
				error: errorPayload(new RendererCrashedError("Browser tab's renderer crashed while the tab was starting")),
			});
			return;
		}
		const run = this.#unanswered;
		if (!run) return;
		this.#unanswered = null;
		run.ac.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser tab's renderer crashed")));
		this.#transport.send({
			type: "result",
			id: run.id,
			ok: false,
			error: errorPayload(new RendererCrashedError("Browser tab's renderer crashed during this run")),
		});
	};
	readonly #onDebuggerDetached = (params: unknown): void => {
		if (this.#debuggerDetached !== undefined) return;
		const reason =
			params && typeof params === "object" && "reason" in params && typeof params.reason === "string"
				? params.reason
				: "no reason given";
		this.#debuggerDetached = reason;
		const run = this.#started ? this.#unanswered : null;
		if (!run) return;
		this.#unanswered = null;
		run.ac.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Chrome detached proto from this tab")));
		this.#transport.send({
			type: "result",
			id: run.id,
			ok: false,
			error: errorPayload(new DebuggerDetachedError(reason, run.codeStarted ? "during-run" : "before-run")),
		});
	};

	constructor(transport: Transport, isolated: boolean) {
		this.#transport = transport;
		this.#isolated = isolated;
		this.#unsub = this.#transport.onMessage(msg => {
			void this.#handleMessage(msg as WorkerInbound);
		});
		this.#uninstallRejectionGuard = this.#installRejectionGuard();
	}

	#installRejectionGuard(): () => void {
		if (!this.#isolated) {
			return postmortem.interceptUnhandledRejections(reason => this.#consumeUnhandledRejection(reason));
		}
		return installBrowserWorkerRejectionGuard(reason => this.#consumeUnhandledRejection(reason));
	}

	#consumeUnhandledRejection(reason: unknown): boolean {
		const active = this.#active;
		if (!active) return false;
		if (!isBrowserRunOwnedRejection(reason, active.rejectionOwner, `browser-run-${active.id}.js`)) return false;
		this.#recordFloatingRejection(active, reason);
		return true;
	}

	#recordFloatingRejection(active: ActiveRun, reason: unknown): void {
		if (postmortem.isExpectedCleanupError(reason)) return;
		if (this.#active !== active) {
			this.#log("warn", "Unhandled rejection after browser run ended", {
				runId: active.id,
				error: reason instanceof Error ? reason.message : String(reason),
			});
			return;
		}
		const isFirst = active.floatingRejections.length === 0;
		active.floatingRejections.push(reason);
		if (isFirst) active.floatingFailure.reject(this.#floatingRejectionError(reason));
	}

	#floatingRejectionError(reason: unknown): Error {
		const message = reason instanceof Error ? reason.message : String(reason);
		const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
		if (reason instanceof Error) error.name = reason.name;
		return error;
	}

	#foldFloatingRejections(active: ActiveRun, failure: { error: unknown } | undefined): { error: unknown } | undefined {
		const rejections = active.floatingRejections;
		if (rejections.length === 0) return failure;
		let reported = rejections;
		if (!failure) {
			failure = { error: this.#floatingRejectionError(rejections[0]) };
			reported = rejections.slice(1);
		} else if (failure.error instanceof Error && failure.error.cause === rejections[0]) {
			reported = rejections.slice(1);
		}
		for (const reason of reported) {
			this.#log("warn", "Additional unhandled browser-run rejection", {
				error: reason instanceof Error ? reason.message : String(reason),
			});
		}
		return failure;
	}

	nextElementId(): number {
		this.#elementCounter += 1;
		return this.#elementCounter;
	}

	cacheObservedElement(id: number, element: ObservedElement): void {
		this.#observedElements.set(id, element);
	}

	cacheElement(id: number, handle: ElementHandle): void {
		this.#elementCache.set(id, handle);
	}

	async #handleMessage(msg: WorkerInbound): Promise<void> {
		switch (msg.type) {
			case "init":
				await this.#init(msg.payload);
				return;
			case "run":
				await this.#run(msg);
				return;
			case "abort":
				if (this.#active?.id === msg.id) {
					const reason = msg.expectedCleanup
						? postmortem.markExpectedCleanupError(new ToolAbortError())
						: new ToolAbortError();
					this.#active.ac.abort(reason);
				}
				return;
			case "tool-reply":
				this.#deliverToolReply(msg.id, msg.reply);
				return;
			case "close":
				await this.#close();
				return;
		}
	}

	async #init(payload: WorkerInitPayload): Promise<void> {
		try {
			this.#mode = payload.mode;
			this.#ownsPage = ownsPage(payload);
			this.#userDriven = payload.mode === "attach" && payload.userDriven === true;
			const puppeteer = await loadPuppeteerInWorker(payload.safeDir);
			this.#browser = await connectPuppeteer(puppeteer, {
				browserWSEndpoint: payload.browserWSEndpoint,
				defaultViewport: null,
				protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
			});
			if (this.#stopped) {
				void this.#browser.disconnect();
				return;
			}
			this.#transport.send({ type: "setup" });
			if (payload.mode === "headless") {
				this.#page = await createTrackedHeadlessPage(this.#browser, targetId => {
					this.#transport.send({ type: "page-created", targetId });
				});
				this.#observeDialogs();
				await applyStealthPatches(this.#browser, this.#page, { browserSession: null, override: null });
				if (payload.emulateViewport !== false) await applyViewport(this.#page, payload.viewport);
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			} else if (payload.page.kind === "create") {
				this.#page = await createTrackedHeadlessPage(
					this.#browser,
					targetId => {
						this.#transport.send({ type: "page-created", targetId });
					},
					true,
				);
				await this.#claimRelayTarget(this.#page);
				this.#observeDialogs();
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			} else {
				const target = await this.#findAttachedTarget(payload.page.targetId);

				if (payload.recover) await this.#recoverAttachedTarget(target);
				const page = await target.page();
				if (!page)
					throw new ToolError(`Target ${payload.page.targetId} is no longer available on the attached browser`);
				this.#page = page;
				await this.#claimRelayTarget(page);
				this.#observeDialogs();
				if (payload.dialogs) this.#applyDialogPolicy(payload.dialogs);
			}
			if (this.#ownsPage) {
				// Background tabs stop producing frames, stalling rAF, IntersectionObserver, and input acks; keep owned tabs
				// interactive without raising a window.
				await this.#page.emulateFocusedPage(true);
			}
			this.#page.on("error", this.#onPageCrashed);
			this.#page.on("request", request => {
				if (request.isNavigationRequest() && request.frame() === this.#page?.mainFrame())
					this.#pendingNavigations.add(request);
			});
			this.#page.on("response", response => this.#pendingNavigations.delete(response.request()));
			this.#page.on("requestfinished", request => this.#pendingNavigations.delete(request));
			this.#page.on("requestfailed", request => this.#pendingNavigations.delete(request));
			const mainClient = this.#page.mainFrame().client;
			const mainFrameId = (this.#page.mainFrame() as unknown as { _id: string })._id;
			mainClient.on("Page.frameRequestedNavigation", event => {
				if (event.frameId === mainFrameId && event.disposition === "currentTab")
					this.#mainFrameNavigationRequested = true;
			});
			mainClient.on("Page.frameNavigated", event => {
				if (event.type === "BackForwardCacheRestore") this.#clearElementCache();
				if (event.frame.parentId === undefined) this.#mainFrameNavigationRequested = false;
			});
			const settled = (event: { frameId: string }): void => {
				if (event.frameId === mainFrameId) this.#mainFrameNavigationRequested = false;
			};
			mainClient.on("Page.navigatedWithinDocument", settled);
			mainClient.on("Page.frameStoppedLoading", settled);
			let beforeUnload = false;
			mainClient.on("Page.javascriptDialogOpening", event => {
				beforeUnload = event.type === "beforeunload";
			});
			mainClient.on("Page.javascriptDialogClosed", event => {
				if (beforeUnload && !event.result) this.#mainFrameNavigationRequested = false;
				beforeUnload = false;
			});
			const client = mainClient as unknown as { on(event: string, handler: (params: unknown) => void): void };
			client.on("PROTO.debuggerDetached", this.#onDebuggerDetached);
			this.#page.on("frameattached", frame => {
				const childClient = frame.client as unknown as {
					on(event: string, handler: (params: unknown) => void): void;
				};
				if (frame.client !== this.#page?.mainFrame().client)
					childClient.on("PROTO.debuggerDetached", this.#onDebuggerDetached);
			});
			await installCancelledReleaseGuard(this.#page);
			// A window omp does not size (visible, attached, relay) takes a viewport only when the open asks for one,
			// after the steps that can fail, so a failed open leaves a borrowed tab at its own size. Without `scale` it
			// keeps the window's own device scale (0).
			if (payload.mode === "attach" && payload.viewport) {
				await this.#page.setViewport({
					...payload.viewport,
					deviceScaleFactor: payload.viewport.deviceScaleFactor ?? 0,
				});
			}
			this.#targetId = await targetIdForPage(this.#page);
			const info = await this.#currentReadyInfo();
			if (this.#crashed || this.#stopped) return;
			this.#started = true;
			this.#transport.send({ type: "ready", info });
		} catch (error) {
			// A failed headless init would orphan its page in the shared browser; attach mode adopts an existing target.
			const page = this.#page;
			if (this.#ownsPage && page && !page.isClosed()) {
				await page.close().catch(() => undefined);
			}
			this.#transport.send({ type: "init-failed", error: errorPayload(error) });
		}
	}

	async #findAttachedTarget(targetId: string): Promise<Target> {
		if (!this.#browser) throw new ToolError("Browser is not connected");
		for (const target of this.#browser.targets()) {
			if ((await targetIdForTarget(target).catch(() => "")) !== targetId) continue;
			return target;
		}
		let session: CDPSession | undefined;
		try {
			session = await this.#browser.target().createCDPSession();
			await session.send("Target.getTargetInfo", { targetId });
			const revived = await this.#browser.waitForTarget(
				async target => (await targetIdForTarget(target).catch(() => "")) === targetId,
				{ timeout: 5_000 },
			);
			return revived;
		} catch {
			throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
		} finally {
			void session?.detach().catch(() => undefined);
		}
	}

	async #claimRelayTarget(page: Page): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await page.createCDPSession();

			const raw = session as unknown as { send(method: string): Promise<unknown> };
			await raw.send("PROTO.claimTarget");
		} catch {
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	async #recoverAttachedTarget(target: Target): Promise<void> {
		let session: CDPSession | undefined;
		try {
			session = await target.createCDPSession();
			session.on("Inspector.targetCrashed", this.#onPageCrashed);
			await session.send("Inspector.enable").catch(() => undefined);
			await session.send("Page.enable").catch(() => undefined);
			await session.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
			await session.send("Page.stopLoading").catch(() => undefined);
			await session.send("Fetch.disable").catch(() => undefined);
		} catch (error) {
			this.#log("debug", "Recovery CDP session failed; proceeding with attach", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await session?.detach().catch(() => undefined);
		}
	}

	#observeDialogs(): void {
		const page = this.#requirePage();
		page.on("request", request => {
			if (request.isNavigationRequest() && request.frame() === page.mainFrame())
				this.#pendingNavigations.add(request);
		});
		page.on("response", response => this.#pendingNavigations.delete(response.request()));
		page.on("requestfinished", request => this.#pendingNavigations.delete(request));
		page.on("requestfailed", request => this.#pendingNavigations.delete(request));
		page.on("dialog", dialog => {
			this.#openDialog = { type: dialog.type(), message: dialog.message() };
		});
		page.on("framenavigated", frame => {
			if (frame === page.mainFrame()) this.#openDialog = undefined;
		});
	}

	async #currentReadyInfo(signal?: AbortSignal): Promise<ReadyInfo> {
		const page = this.#requirePage();
		const targetId = this.#targetId ?? (await targetIdForPage(page));
		this.#targetId = targetId;
		const info = await collectReadyInfo(page, targetId, {
			signal,
			dialogOpen: this.#openDialog !== undefined,
			lastViewport: this.#lastViewport,
		});
		this.#lastViewport = info.viewport;
		return info;
	}

	#applyDialogPolicy(policy: DialogPolicy): void {
		const page = this.#requirePage();
		if (this.#dialogPolicy === policy && this.#dialogHandler) return;
		if (this.#dialogHandler) page.off("dialog", this.#dialogHandler);
		const handler = (dialog: Dialog): void => {
			const action = policy === "accept" ? dialog.accept() : dialog.dismiss();
			void action.then(
				() => {
					this.#openDialog = undefined;
				},
				err =>
					this.#log("debug", "Dialog auto-handler failed", {
						policy,
						error: err instanceof Error ? err.message : String(err),
					}),
			);
		};
		page.on("dialog", handler);
		this.#dialogPolicy = policy;
		this.#dialogHandler = handler;
	}

	async #postReadyInfo(signal: AbortSignal): Promise<void> {
		try {
			this.#transport.send({ type: "ready", info: await this.#currentReadyInfo(signal) });
		} catch (error) {
			this.#log("debug", "Failed to refresh tab info", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #run(msg: Extract<WorkerInbound, { type: "run" }>): Promise<void> {
		if (this.#crashed || this.#debuggerDetached !== undefined) {
			const error = this.#crashed
				? new RendererCrashedError("Browser tab's renderer had crashed before this run, so its code did not run")
				: new DebuggerDetachedError(this.#debuggerDetached!, "before-run");
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(error) });
			return;
		}
		if (this.#active) {
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: false,
				error: errorPayload(new ToolError("Tab worker is busy")),
			});
			return;
		}
		const timeoutSignal = AbortSignal.timeout(msg.timeoutMs);
		const ac = new AbortController();
		const runAc = new AbortController();
		const signal = AbortSignal.any([timeoutSignal, ac.signal, runAc.signal]);
		const output = new RunOutput(msg.session.outputArtifact);
		const screenshots: ScreenshotResult[] = [];
		const floatingFailure = Promise.withResolvers<never>();
		const active: ActiveRun = {
			id: msg.id,
			ac,
			signal,
			output,
			screenshots,
			pendingTools: new Map(),
			rejectionOwner: {},
			floatingRejections: [],
			floatingFailure,
			inflight: new Map(),
			opCounter: 0,
			codeStarted: false,
		};
		this.#active = active;
		this.#unanswered = active;
		let completed = false;
		let recoverTab = false;
		let returnValue: unknown;
		let failure: { error: unknown } | undefined;
		let runPage: RunPageScope | undefined;
		try {
			throwIfAborted(signal);
			runPage = createRunPageScope(this.#requirePage(), () => this.#requirePage().setRequestInterception(false));
			const browser = this.#requireBrowser();
			const tabApi = this.#createTabApi(msg.name, msg.timeoutMs, signal, msg.session, output, screenshots, active);
			const runtime = this.#ensureRuntime(msg.session);
			runtime.setCwd(msg.session.cwd);
			const onFloatingRejection = (reason: unknown): void => this.#recordFloatingRejection(active, reason);
			runtime.setRunScope({
				page: bindRunFacade(runPage.page, signal, active.rejectionOwner, onFloatingRejection),
				browser: bindRunFacade(browser, signal, active.rejectionOwner, onFloatingRejection),
				tab: bindRunFacade(tabApi, signal, active.rejectionOwner, onFloatingRejection),
				assert: (cond: unknown, text?: string): void => {
					if (!cond) throw new ToolError(text ?? "Assertion failed");
				},

				wait: (msOrPredicate: number | (() => unknown), opts?: WaitPredicateOptions): Promise<unknown> => {
					const label = typeof msOrPredicate === "number" ? `wait(${msOrPredicate}ms)` : "wait(predicate)";
					const resolved =
						typeof msOrPredicate === "number"
							? undefined
							: { timeout: resolvePredicateTimeout(msg.timeoutMs, opts?.timeout), interval: opts?.interval };
					return observeBrowserRunPromise(
						this.#runOp(active, label, signal, Number.POSITIVE_INFINITY, sig =>
							waitForRun(msOrPredicate, sig, resolved),
						),
						active.rejectionOwner,
						onFloatingRejection,
					);
				},
			});
			const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
			const onCancel = (): void => {
				const abortError =
					signal.reason instanceof ToolAbortError
						? signal.reason
						: new ToolAbortError(undefined, { cause: signal.reason });
				if (timeoutSignal.aborted) {
					const stalled = describeInflight(active.inflight);
					const dialog = this.#openDialog;
					const dialogNote = dialog
						? `; a ${dialog.type}(${JSON.stringify(dialog.message.slice(0, 80))}) dialog opened during this run and may still block the page — reopen the tab with dialogs:"accept"|"dismiss" or handle page.on('dialog')`
						: "";
					rejectCancel(
						new ToolError(
							`Browser code execution timed out after ${msg.timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}`,
						),
					);
				} else {
					rejectCancel(abortError);
				}

				const toolAbort = timeoutSignal.aborted
					? postmortem.markExpectedCleanupError(new ToolAbortError(undefined, { cause: timeoutSignal.reason }))
					: abortError;
				for (const pending of active.pendingTools.values()) {
					pending.reject(toolAbort);
				}
				active.pendingTools.clear();
			};
			if (signal.aborted) onCancel();
			else signal.addEventListener("abort", onCancel, { once: true });
			try {
				const hooks = this.#hooksForActiveRun();
				if (!hooks) throw new ToolError("Browser runtime started without an active run");
				returnValue = await withBrowserPromiseCombinatorTracking(
					active.rejectionOwner,
					onFloatingRejection,
					async () =>
						await Promise.race([
							runtime.run(msg.code, `browser-run-${msg.id}.js`, hooks, {
								runId: msg.id,
								cwd: msg.session.cwd,
								signal,
								onCodeStart: () => {
									active.codeStarted = true;
								},
							}),
							cancelRejection,
							floatingFailure.promise,
						]),
				);
				completed = true;
			} finally {
				signal.removeEventListener("abort", onCancel);
			}
		} catch (error) {
			failure = { error };
		} finally {
			runAc.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Browser run ended")));
			await Bun.sleep(0);
			runPage?.detach();
			if (ac.signal.aborted && this.#pendingNavigations.size > 0) await this.#stopLoading();
			try {
				await runPage?.restoreInterception();
			} catch (error) {
				if (completed && active.floatingRejections.length === 0) {
					recoverTab = true;
					this.#log("warn", "Browser tab state could not be restored after a completed run", {
						error: error instanceof Error ? error.message : String(error),
					});
				} else failure = { error };
			}
			failure = this.#foldFloatingRejections(active, failure);
			if (this.#active?.id === msg.id) this.#active = null;
		}
		if (this.#unanswered !== active) {
			await output.dispose();
			return;
		}
		if (failure) {
			if (isPuppeteerTargetClose(failure.error) && this.#userDriven) {
				const page = this.#page;
				if (page && !page.isClosed())
					await withTimeout(
						page.mainFrame().client.send("Target.getTargetInfo"),
						500,
						"Timed out waiting for the relay detach report",
					).catch(() => undefined);
				if (this.#unanswered !== active) {
					await output.dispose();
					return;
				}
			}
			this.#unanswered = null;
			await output.dispose();
			this.#transport.send({ type: "result", id: msg.id, ok: false, error: errorPayload(failure.error) });
			return;
		}
		if (completed) {
			await this.#postReadyInfo(AbortSignal.any([timeoutSignal, ac.signal]));
			if (this.#unanswered !== active) {
				await output.dispose();
				return;
			}
			this.#unanswered = null;
			this.#transport.send({
				type: "result",
				id: msg.id,
				ok: true,
				payload: { ...(await output.finish(returnValue)), screenshots, recoverTab: recoverTab || undefined },
			});
		}
	}

	#ensureRuntime(session: SessionSnapshot): JsRuntime {
		if (this.#runtime) return this.#runtime;
		this.#runtime = new JsRuntime({
			initialCwd: session.cwd,
			sessionId: `browser-tab-${this.#targetId ?? "unknown"}`,
		});
		return this.#runtime;
	}

	#hooksForActiveRun(): RuntimeHooks | null {
		const active = this.#active;
		if (!active) return null;
		return {
			onText: chunk => {
				throwIfAborted(active.signal);
				active.output.pushText(chunk);
			},
			onDisplay: output => {
				throwIfAborted(active.signal);
				active.output.pushDisplay(output);
			},
			callTool: (name, args) => {
				throwIfAborted(active.signal);
				return this.#callTool(active, name, args);
			},
		};
	}

	async #callTool(active: ActiveRun, name: string, args: unknown): Promise<unknown> {
		const id = `tab-tc-${active.id}-${crypto.randomUUID()}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		active.pendingTools.set(id, { resolve, reject });
		this.#transport.send({ type: "tool-call", id, runId: active.id, name, args });
		return await promise;
	}

	#deliverToolReply(id: string, reply: ToolReply): void {
		const active = this.#active;
		if (!active) return;
		const pending = active.pendingTools.get(id);
		if (!pending) return;
		active.pendingTools.delete(id);
		if (reply.ok) pending.resolve(reply.value);
		else pending.reject(replyError(reply.error));
	}

	async #runOp<T>(
		active: ActiveRun,
		label: string,
		cellSignal: AbortSignal,
		perOpTimeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
		opts?: { selector?: string; zeroMatchAfterMs?: number },
	): Promise<T> {
		const opId = active.opCounter++;
		active.inflight.set(opId, { label, startedAt: Date.now() });
		const capped = Number.isFinite(perOpTimeoutMs) && perOpTimeoutMs > 0;
		const opTimeout = capped ? AbortSignal.timeout(perOpTimeoutMs) : undefined;
		const opSignal = opTimeout ? AbortSignal.any([cellSignal, opTimeout]) : cellSignal;
		const selector = opts?.selector;
		const watchdog =
			selector !== undefined && opts?.zeroMatchAfterMs !== undefined && parseAriaRefSelector(selector) === null
				? { selector, afterMs: opts.zeroMatchAfterMs }
				: undefined;

		const earlyAc = new AbortController();
		try {
			if (!watchdog) return await fn(opSignal);
			const racedSignal = AbortSignal.any([opSignal, earlyAc.signal]);
			return await Promise.race([
				fn(racedSignal),
				this.#zeroMatchWatchdog(watchdog.selector, label, watchdog.afterMs, racedSignal),
			]);
		} catch (err) {
			if (err instanceof ActionabilityTimeoutError) {
				throw markBrowserRunRejection(err, active.rejectionOwner);
			}
			if (capped && !cellSignal.aborted && (opTimeout?.aborted || isPuppeteerTimeout(err))) {
				const hint =
					err instanceof TypingInterruptedError
						? `; ${err.progress}`
						: err instanceof ClickRefusedError
							? `; the element never became clickable (last check: ${err.refusal})`
							: selector
								? await this.#selectorTimeoutHint(selector)
								: "";
				throw markBrowserRunRejection(
					new ToolError(`${label} timed out after ${perOpTimeoutMs}ms${hint}`),
					active.rejectionOwner,
				);
			}
			throw markBrowserRunRejection(err, active.rejectionOwner);
		} finally {
			earlyAc.abort();
			active.inflight.delete(opId);
		}
	}

	async #zeroMatchWatchdog(selector: string, label: string, afterMs: number, signal: AbortSignal): Promise<never> {
		const page = this.#requirePage();
		const resolved = normalizeSelector(selector);
		const deadline = Date.now() + afterMs;
		while (!signal.aborted) {
			let count: number | null = null;
			try {
				const handles = await querySelectorAll(page, resolved);
				count = handles.length;
				for (const handle of handles) void handle.dispose().catch(() => undefined);
			} catch {}
			if (count !== null && count > 0) break;
			if (count === 0 && Date.now() >= deadline) {
				throw new ToolError(`${label} failed fast after ${afterMs}ms${formatSelectorMatchHint(0)}`);
			}
			try {
				await untilAborted(signal, () => Bun.sleep(ZERO_MATCH_POLL_MS));
			} catch {
				break;
			}
		}
		return await new Promise<never>(() => {});
	}

	async #selectorTimeoutHint(selector: string): Promise<string> {
		if (parseAriaRefSelector(selector) !== null) return "";
		const timeoutMs = 1_000;
		const pending = querySelectorAll(this.#requirePage(), selector);
		try {
			const handles = await Promise.race([pending, Bun.sleep(timeoutMs).then(() => null)]);
			if (!handles) {
				void pending
					.then(late => Promise.all(late.map(handle => handle.dispose().catch(() => undefined))))
					.catch(() => undefined);
				return `; could not count matches: no answer within ${timeoutMs}ms`;
			}
			for (const handle of handles) void handle.dispose().catch(() => undefined);
			return formatSelectorMatchHint(handles.length);
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0];
			return `; could not count matches: ${message || (error instanceof Error ? error.name : "unknown error")}`;
		}
	}

	#createTabApi(
		name: string,
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		active: ActiveRun,
	): TabApi {
		const page = this.#requirePage();
		const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(timeoutMs);
		const waitMs = (explicit?: number): number => resolveWaitTimeout(timeoutMs, explicit);
		const INF = Number.POSITIVE_INFINITY;
		const op = <T>(
			label: string,
			perOpMs: number,
			fn: (sig: AbortSignal) => Promise<T>,
			selectorOpts?: { selector?: string; zeroMatchAfterMs?: number },
		): Promise<T> =>
			markHandled(
				this.#runOp(
					active,
					label,
					signal,
					perOpMs,
					async sig => {
						if (
							!/^tab\.(?:goto|waitForNavigation|waitForResponse|scroll|drag)\(/.test(label) &&
							!label.startsWith("handle.")
						) {
							const settled = await waitForMainFrameDocument(
								page,
								() => this.#mainFrameNavigationRequested,
								Math.min(REQUESTED_NAVIGATION_WAIT_MS, perOpMs / 2),
								sig,
							);
							if (!settled) this.#mainFrameNavigationRequested = false;
						}
						try {
							return await fn(sig);
						} catch (error) {
							// Only our own idempotent reads can be repeated. User evaluate code may already have changed the page.
							if (
								sig.aborted ||
								!/^tab\.(?:title|text|html|observe|ariaSnapshot|extract)\(/.test(label) ||
								!isNavigatedContextError(error)
							)
								throw error;
							await waitForMainFrameDocument(
								page,
								() => this.#mainFrameNavigationRequested,
								Math.min(REQUESTED_NAVIGATION_WAIT_MS, perOpMs / 2),
								sig,
								true,
							);
							return await fn(sig);
						}
					},
					selectorOpts,
				),
			);
		const enrich = (handle: ElementHandle): ActionableHandle =>
			toActionableHandle(
				handle,
				(label, fn) => op(label, actionOpMs, fn),
				async () => {
					this.#clearElementCache();
					await this.#stopLoading();
				},
				(paths, sig) => this.#uploadToHandle(handle, paths, sig, session),
			);
		return {
			name,
			page,
			signal,
			url: () => page.url(),
			title: () => op("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
			text: (selector = "body") =>
				op(`tab.text(${JSON.stringify(selector)})`, quickOpMs, sig =>
					untilAborted(sig, () =>
						page.$eval(normalizeSelector(selector), element => {
							const rendered = "innerText" in element ? element.innerText : undefined;
							return (typeof rendered === "string" ? rendered : (element.textContent ?? "")).trim();
						}),
					),
				),
			html: (selector = "body") =>
				op(`tab.html(${JSON.stringify(selector)})`, quickOpMs, sig =>
					untilAborted(sig, () => page.$eval(normalizeSelector(selector), element => element.innerHTML)),
				),
			goto: (url, opts) => {
				const navigationTimeoutMs = opts?.timeout === undefined ? budgetBound : waitMs(opts.timeout);
				return op(`tab.goto(${JSON.stringify(url)})`, navigationTimeoutMs, async sig => {
					this.#clearElementCache();
					try {
						await navigateMainFrame(page, opts?.waitUntil ?? "load", navigationTimeoutMs, sig, options =>
							page.goto(url, options),
						);
					} catch (err) {
						if (isPuppeteerTimeout(err) || (sig.aborted && !signal.aborted)) {
							await this.#stopLoading();
							throw new NavigationTimeoutError(
								`tab.goto(${JSON.stringify(url)}) timed out after ${navigationTimeoutMs}ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:"domcontentloaded"`,
							);
						}
						if (url.startsWith("file:")) throw fileUrlNavigationError(url, err);
						throw err;
					}
				});
			},
			observe: opts => op("tab.observe()", quickOpMs, sig => this.#collectObservation({ ...opts, signal: sig })),
			ariaSnapshot: (selector, opts) =>
				op(
					selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()",
					quickOpMs,
					async sig => {
						let root: ElementHandle | null = null;
						if (selector) {
							root = await untilAborted(sig, () => querySelector(page, selector));
							if (!root)
								throw new ToolError(
									`tab.ariaSnapshot: selector ${JSON.stringify(selector)} matched no element`,
								);
						}
						try {
							return await untilAborted(sig, () => captureAriaSnapshot(page, root, opts));
						} finally {
							await root?.dispose().catch(() => undefined);
						}
					},
				),
			screenshot: opts =>
				op(describeScreenshot(opts), quickOpMs, sig =>
					this.#captureScreenshot(session, output, screenshots, sig, opts),
				),
			extract: (format = "markdown") =>
				op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
					const html = (await untilAborted(sig, () => page.content())) as string;
					const result = await extractReadableFromHtml(html, page.url(), format);
					if (!result) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`,
						);
					}
					const content = format === "markdown" ? result.markdown : result.text;
					if (!content) {
						throw new ToolError(
							`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`,
						);
					}
					return content;
				}),
			click: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.click(${JSON.stringify(selector)})`,
					w,
					async sig => {
						const click = { button: opts?.button, clickCount: opts?.count };
						if (parseAriaRefSelector(selector) !== null) {
							const handle = await this.#resolveAriaRef(selector);
							try {
								await clickElement(handle, `tab.click(${JSON.stringify(selector)})`, sig, click);
							} finally {
								await handle.dispose().catch(() => undefined);
							}
							return;
						}
						const resolved = normalizeSelector(selector);
						if (resolved.startsWith("text/")) await clickQueryHandlerText(page, resolved, w, sig, click);
						else await clickSelector(page, resolved, w, sig, click);
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				);
			},
			type: (selector, text, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.type(${JSON.stringify(selector)})`,
					w,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, w, sig);
						try {
							await typeIntoElement(handle, text, sig, { delay: 0 });
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				);
			},
			fill: (selector, value, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.fill(${JSON.stringify(selector)})`,
					w,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, w, sig);
						try {
							await fillViaHandle(handle, value, sig);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				);
			},
			press: (key, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.press(${JSON.stringify(key)})`,
					w,
					async sig => {
						assertTabPressArgs(key, opts);
						const selector = opts?.selector;
						if (selector) {
							if (parseAriaRefSelector(selector) !== null) {
								const handle = await this.#resolveAriaRef(selector);
								try {
									await untilAborted(sig, () => handle.focus());
								} finally {
									await handle.dispose().catch(() => undefined);
								}
							} else {
								const handle = await this.#resolveActionHandle(selector, w, sig);
								try {
									await untilAborted(sig, () => handle.focus());
								} finally {
									await handle.dispose().catch(() => undefined);
								}
							}
						}
						await pressKey(page, key, undefined, sig);
					},
					{ selector: opts?.selector, zeroMatchAfterMs: opts?.selector ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			scroll: (deltaX, deltaY) =>
				op("tab.scroll()", actionOpMs, sig =>
					untilAborted(sig, () => dispatchScroll(() => page.mouse.wheel({ deltaX, deltaY }))),
				),
			drag: (from, to) => op("tab.drag()", actionOpMs, sig => this.#drag(from, to, sig)),
			waitFor: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitFor(${JSON.stringify(selector)})`,
					w,
					async sig => enrich(await this.#resolveActionHandle(selector, w, sig)),
					{ selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
				);
			},
			waitForSelector: (selector, opts) => {
				const w = waitMs(opts?.timeout);
				return op(
					`tab.waitForSelector(${JSON.stringify(selector)})`,
					w,
					async sig => {
						if (parseAriaRefSelector(selector) !== null) return enrich(await this.#resolveAriaRef(selector));
						const handle = (await untilAborted(sig, () =>
							page.waitForSelector(normalizeSelector(selector), {
								timeout: w,
								visible: opts?.visible,
								hidden: opts?.hidden,
								signal: sig,
							}),
						)) as ElementHandle | null;
						return handle ? enrich(handle) : null;
					},
					{
						selector,

						zeroMatchAfterMs: opts?.timeout === undefined && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : undefined,
					},
				);
			},
			waitForNavigation: opts => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForNavigation()", w, sig =>
					untilAborted(sig, () =>
						page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "load", timeout: w, signal: sig }),
					),
				);
			},
			evaluate: (fn, ...args) =>
				op("tab.evaluate()", INF, sig =>
					untilAborted(sig, async () => {
						const realm = page.mainFrame().mainRealm();
						if (typeof fn === "string") return realm.evaluate(fn);
						const { args: adopted, dispose } = await adoptElementArgs(realm, args);
						try {
							throwIfAborted(sig);
							return await realm.evaluate(fn as (...a: unknown[]) => unknown, ...adopted);
						} finally {
							await dispose();
						}
					}),
				) as never,
			scrollIntoView: selector =>
				op(
					`tab.scrollIntoView(${JSON.stringify(selector)})`,
					actionOpMs,
					async sig => {
						const handle = await this.#resolveActionHandle(selector, actionOpMs, sig);
						try {
							await untilAborted(sig, () =>
								handle.evaluate(el => {
									const target = el as unknown as {
										scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
									};
									target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
								}),
							);
						} finally {
							await handle.dispose().catch(() => undefined);
						}
					},
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			select: (selector, ...valuesAndOptions) => {
				const values = [...valuesAndOptions];
				const maybeOptions = values.at(-1);
				const opts =
					typeof maybeOptions === "object" && maybeOptions !== null
						? (values.pop() as TabActionOptions)
						: undefined;
				const w = waitMs(opts?.timeout);
				return op(
					`tab.select(${JSON.stringify(selector)})`,
					w,
					sig => this.#select(selector, values as string[], w, sig),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				);
			},
			uploadFile: (selector, ...filePaths) =>
				op(
					`tab.uploadFile(${JSON.stringify(selector)})`,
					actionOpMs,
					sig => this.#uploadFile(selector, filePaths, actionOpMs, sig, session),
					{ selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
				),
			waitForUrl: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForUrl()", w, sig => this.#waitForUrl(pattern, w, sig));
			},
			waitForResponse: (pattern, opts) => {
				const w = waitMs(opts?.timeout);
				return op("tab.waitForResponse()", w, sig => this.#waitForResponse(pattern, w, sig));
			},
			id: async id => enrich(await this.#resolveCachedHandle(id)),
			ref: async id => enrich(await this.#resolveAriaRef(id)),
		};
	}

	async #collectObservation(options: {
		includeAll?: boolean;
		viewportOnly?: boolean;
		selector?: string;
		signal?: AbortSignal;
	}): Promise<Observation> {
		const page = this.#requirePage();
		this.#clearElementCache();
		const includeAll = options.includeAll ?? false;
		const viewportOnly = options.viewportOnly ?? false;
		const root = options.selector
			? await untilAborted(options.signal, () => querySelector(page, options.selector!))
			: null;
		if (options.selector && !root)
			throw new ToolError(`tab.observe: selector ${JSON.stringify(options.selector)} matched no element`);
		let snapshot: SerializedAXNode | null;
		let frameSnapshots: FrameSnapshot[];
		try {
			snapshot = await untilAborted(options.signal, () =>
				page.accessibility.snapshot({ interestingOnly: !includeAll, root: root ?? undefined }),
			);
			frameSnapshots = await snapshotFrames(page.mainFrame().childFrames(), {
				interestingOnly: !includeAll,
				root,
				deadline: Date.now() + FRAME_SNAPSHOT_TIMEOUT_MS,
				signal: options.signal,
			});
		} finally {
			void root?.dispose().catch(() => undefined);
		}
		if (!snapshot) throw new ToolError("Accessibility snapshot unavailable");
		const entries: ObservationEntry[] = [];
		for (const tree of [{ frame: page.mainFrame(), snapshot }, ...frameSnapshots]) {
			await collectObservationEntries(this, tree.snapshot, entries, {
				includeAll,
				viewportOnly,
				frame: tree.frame,
				signal: options.signal,
			});
		}
		const scroll = (await untilAborted(options.signal, () =>
			page.evaluate(() => {
				const win = globalThis as unknown as {
					scrollX: number;
					scrollY: number;
					innerWidth: number;
					innerHeight: number;
					document: { documentElement: { scrollWidth: number; scrollHeight: number } };
				};
				const doc = win.document.documentElement;
				return {
					x: win.scrollX,
					y: win.scrollY,
					width: win.innerWidth,
					height: win.innerHeight,
					scrollWidth: doc.scrollWidth,
					scrollHeight: doc.scrollHeight,
				};
			}),
		)) as Observation["scroll"];
		return {
			url: page.url(),
			title: (await untilAborted(options.signal, () => page.title())) as string,
			viewport: await readBrowserViewport(page, options.signal),
			scroll,
			elements: entries,
		};
	}

	async #captureScreenshot(
		session: SessionSnapshot,
		output: RunOutput,
		screenshots: ScreenshotResult[],
		signal: AbortSignal | undefined,
		opts: ScreenshotOptions = {},
	): Promise<string> {
		const page = this.#requirePage();

		const fullPage = opts.selector ? false : (opts.fullPage ?? false);
		const captureType = "png";
		const captureMime = "image/png" as const;
		const captureScale = opts.silent ? undefined : ((await readBrowserViewport(page, signal)).deviceScaleFactor ?? 1);
		let buffer: Buffer;
		if (opts.selector) {
			const handle =
				parseAriaRefSelector(opts.selector) !== null
					? await this.#resolveAriaRef(opts.selector)
					: asElementHandle(await untilAborted(signal, () => querySelector(page, opts.selector!)));
			if (!handle) throw new ToolError("Screenshot selector did not resolve to an element");
			try {
				await untilAborted(signal, () =>
					handle.evaluate(el => {
						const target = el as unknown as {
							scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void;
						};
						target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
					}),
				).catch(() => undefined);

				const shotOpts: ElementScreenshotOptions = { type: captureType, scrollIntoView: false };
				buffer = (await whileDrawing(page, signal, () =>
					untilAborted(signal, () => handle.screenshot(shotOpts)),
				)) as Buffer;
			} finally {
				await handle.dispose().catch(() => undefined);
			}
		} else {
			buffer = (await whileDrawing(page, signal, () =>
				untilAborted(signal, () => page.screenshot({ type: captureType, fullPage })),
			)) as Buffer;
		}
		const resized = await resizeImage(
			{ type: "image", data: buffer.toBase64(), mimeType: captureMime },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70, excludeWebP: session.excludeWebP },
		);
		const saveFullRes = !!session.browserScreenshotDir;
		const savedBuffer = saveFullRes ? buffer : resized.buffer;
		const savedMimeType = saveFullRes ? captureMime : resized.mimeType;
		const ext = savedMimeType === "image/webp" ? "webp" : savedMimeType === "image/jpeg" ? "jpg" : "png";
		const dest = session.browserScreenshotDir
			? path.join(
					session.browserScreenshotDir,
					`screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`,
				)
			: path.join(os.tmpdir(), `proto-sshots-${Snowflake.next()}.${ext}`);
		await fs.promises.mkdir(path.dirname(dest), { recursive: true });
		await Bun.write(dest, savedBuffer);
		const info: ScreenshotResult = {
			dest,
			mimeType: savedMimeType,
			bytes: savedBuffer.length,
			width: resized.width,
			height: resized.height,
		};
		const admitted = output.admitMetadata(info);
		if (admitted) screenshots.push(admitted);
		if (!opts.silent) {
			const lines = formatScreenshot({
				saveFullRes,
				savedMimeType,
				savedByteLength: savedBuffer.length,
				dest,
				resized,
			});
			if (captureScale)
				lines.push(
					`Image coordinates × ${(resized.originalWidth / resized.width / captureScale).toPrecision(6)} = CSS ${opts.selector ? "element-relative" : fullPage ? "page" : "viewport"} coordinates.`,
				);
			output.push({ type: "text", text: lines.join("\n") });
			output.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
		}
		return dest;
	}

	async #drag(from: DragTarget, to: DragTarget, signal: AbortSignal): Promise<void> {
		const page = this.#requirePage();
		const resolveDragPoint = async (
			target: DragTarget,
			role: "from" | "to",
		): Promise<{ x: number; y: number; handle?: ElementHandle }> => {
			if (typeof target === "string") {
				const handle =
					parseAriaRefSelector(target) !== null
						? await this.#resolveAriaRef(target)
						: asElementHandle(await untilAborted(signal, () => querySelector(page, target)));
				if (!handle) throw new ToolError(`Drag ${role} selector did not resolve: ${target}`);
				const box = (await untilAborted(signal, () => handle.boundingBox())) as {
					x: number;
					y: number;
					width: number;
					height: number;
				} | null;
				if (!box) {
					await handle.dispose().catch(() => undefined);
					throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
				}
				return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
			}
			if (
				target !== null &&
				typeof target === "object" &&
				typeof (target as { x: unknown }).x === "number" &&
				typeof (target as { y: unknown }).y === "number"
			) {
				return { x: (target as { x: number }).x, y: (target as { y: number }).y };
			}
			throw new ToolError(
				`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`,
			);
		};
		const start = await resolveDragPoint(from, "from");
		let end: { x: number; y: number; handle?: ElementHandle } | undefined;
		try {
			end = await resolveDragPoint(to, "to");
			await dragBetween(page, start, end, signal);
		} finally {
			if (start.handle) await start.handle.dispose().catch(() => undefined);
			if (end?.handle) await end.handle.dispose().catch(() => undefined);
		}
	}

	async #select(selector: string, values: string[], timeoutMs: number, signal: AbortSignal): Promise<string[]> {
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			return await selectElementOptions(handle, values, "tab.select()", signal);
		} finally {
			void handle.dispose().catch(() => undefined);
		}
	}

	async #uploadToHandle(
		handle: ElementHandle,
		filePaths: string[],
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
		const absolute = filePaths.map(filePath => resolveToCwd(filePath, session.cwd));
		if (this.#mode === "attach") return await uploadFileContents(handle, absolute, signal);
		const fileInput = await untilAborted(signal, () =>
			handle.evaluate(el => {
				const input = el as unknown as { localName: string; type: string };
				return input.localName === "input" && input.type.toLowerCase() === "file";
			}),
		);
		if (!fileInput) throw new ToolError("tab.uploadFile() requires an <input type=file> element");
		const raw = (handle as HandleWithRawMethods)[RAW_HANDLE_METHODS]?.interactive.uploadFile;
		await untilAborted(signal, () => (raw ? raw(...absolute) : handle.uploadFile(...absolute)));
	}

	async #uploadFile(
		selector: string,
		filePaths: string[],
		timeoutMs: number,
		signal: AbortSignal,
		session: SessionSnapshot,
	): Promise<void> {
		const handle = await this.#resolveActionHandle(selector, timeoutMs, signal);
		try {
			await this.#uploadToHandle(handle, filePaths, signal, session);
		} finally {
			void handle.dispose().catch(() => undefined);
		}
	}

	async #waitForUrl(pattern: string | RegExp, timeout: number, signal: AbortSignal): Promise<string> {
		const page = this.#requirePage();
		const isRegex = pattern instanceof RegExp;
		const matcher = isRegex ? pattern.source : pattern;
		const flags = isRegex ? pattern.flags : "";
		await untilAborted(signal, () =>
			page.waitForFunction(
				(m: string, isRe: boolean, fl: string) => {
					const url = (globalThis as unknown as { location: { href: string } }).location.href;
					return isRe ? new RegExp(m, fl).test(url) : url.includes(m);
				},
				{ timeout, polling: 200, signal },
				matcher,
				isRegex,
				flags,
			),
		);
		return page.url();
	}

	async #waitForResponse(
		pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
		timeout: number,
		signal: AbortSignal,
	): Promise<HTTPResponse> {
		const page = this.#requirePage();
		const predicate: (response: HTTPResponse) => boolean | Promise<boolean> =
			typeof pattern === "function"
				? pattern
				: pattern instanceof RegExp
					? response => pattern.test(response.url())
					: response => response.url().includes(pattern);
		return (await untilAborted(signal, () => page.waitForResponse(predicate, { timeout, signal }))) as HTTPResponse;
	}

	async #resolveCachedHandle(id: number): Promise<ElementHandle> {
		const element = this.#observedElements.get(id);
		if (element && isObservedDocumentGone(element)) {
			this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		const handle = this.#elementCache.get(id);
		if (!handle) {
			if (!element) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
			const resolved = await resolveObservedElement(element);
			if (!resolved || this.#observedElements.get(id) !== element) {
				void resolved?.dispose().catch(() => undefined);
				if (this.#observedElements.get(id) === element) this.#clearElementCache();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
			const cached = this.#elementCache.get(id);
			if (cached) {
				void resolved.dispose().catch(() => undefined);
				return cached;
			}
			this.#elementCache.set(id, resolved);
			return resolved;
		}
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				this.#clearElementCache();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
		} catch (err) {
			if (err instanceof ToolError) throw err;
			this.#clearElementCache();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		return handle;
	}

	async #resolveAriaRef(id: string): Promise<ElementHandle> {
		const ref = parseAriaRefSelector(id) ?? id.trim();
		const handle = await resolveAriaRefHandle(this.#requirePage(), ref);
		if (!handle) {
			throw new ToolError(
				`Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
			);
		}
		return handle;
	}

	async #resolveActionHandle(selector: string, timeoutMs: number, sig: AbortSignal): Promise<ElementHandle> {
		if (parseAriaRefSelector(selector) !== null) return this.#resolveAriaRef(selector);
		return await waitForActionableHandle(this.#requirePage(), selector, timeoutMs, sig, "resolving", false);
	}
	#clearElementCache(): void {
		this.#observedElements.clear();
		if (this.#elementCache.size === 0) {
			this.#elementCounter = 0;
			return;
		}
		const handles = [...this.#elementCache.values()];
		this.#elementCache.clear();
		this.#elementCounter = 0;
		for (const handle of handles) void handle.dispose().catch(() => undefined);
	}

	async #stopLoading(): Promise<void> {
		try {
			const session = await this.#requirePage().createCDPSession();
			try {
				await session.send("Page.stopLoading");
			} finally {
				await session.detach().catch(() => undefined);
			}
		} catch (error) {
			this.#log("debug", "Page.stopLoading failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	terminate(): void {
		this.#stop();
		this.#active?.ac.abort(postmortem.markExpectedCleanupError(new ToolAbortError("Tab worker terminated")));
		if (this.#browser?.connected) void this.#browser.disconnect();
	}

	#stop(): boolean {
		if (this.#stopped) return false;
		this.#stopped = true;
		this.#unsub();
		this.#uninstallRejectionGuard();
		return true;
	}

	async #close(): Promise<void> {
		if (!this.#stop()) return;
		this.#clearElementCache();
		const page = this.#page;
		if (this.#dialogHandler && page && !page.isClosed()) page.off("dialog", this.#dialogHandler);
		if (this.#ownsPage && page && !page.isClosed()) await page.close().catch(() => undefined);
		if (this.#browser?.connected) this.#browser.disconnect();
		this.#transport.send({ type: "closed" });
		this.#transport.close();
	}

	#requirePage(): Page {
		if (!this.#page) throw new ToolError("Tab worker is not initialized");
		return this.#page;
	}

	#requireBrowser(): Browser {
		if (!this.#browser) throw new ToolError("Tab worker is not initialized");
		return this.#browser;
	}

	#log(level: "debug" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
		this.#transport.send({ type: "log", level, msg, meta });
	}
}
