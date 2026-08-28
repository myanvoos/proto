import * as url from "node:url";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { isSettingsInitialized, settings } from "../config/settings";
import { LocalProtocolHandler, resolveLocalUrlToPath } from "../internal-urls";

const OSC = "\x1b]";
const ST = "\x1b\\";
const BEL = "\x07";

function buildLinkId(uri: string): string {
	let h = 0;
	for (let i = 0; i < uri.length; i++) {
		h = (Math.imul(31, h) + uri.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function buildFileUri(filePath: string, opts?: { line?: number; col?: number }): string {
	const uri = url.pathToFileURL(filePath);
	if (opts?.line !== undefined) uri.searchParams.set("line", String(opts.line));
	if (opts?.col !== undefined) uri.searchParams.set("col", String(opts.col));
	return uri.href;
}

export function isHyperlinkEnabled(): boolean {
	if (!isSettingsInitialized()) return false;
	const mode = settings.get("tui.hyperlinks");
	if (mode === "off") return false;
	if (mode === "always") return true;

	if (Bun.env.NO_COLOR) return false;
	if (!process.stdout.isTTY) return false;
	return TERMINAL.hyperlinks;
}

function safeHyperlinkUri(uri: string): string | undefined {
	if (!uri || /[\x00-\x1f\x7f]/.test(uri)) return undefined;
	return uri;
}

function wrapHyperlinkCore(uri: string, displayText: string, terminator: typeof ST | typeof BEL): string {
	if (displayText.includes("\x1b]8;")) return displayText;
	const safeUri = safeHyperlinkUri(uri);
	if (!safeUri) return displayText;
	const id = buildLinkId(safeUri);
	return `${OSC}8;id=${id};${safeUri}${terminator}${displayText}${OSC}8;;${terminator}`;
}

function wrapHyperlink(uri: string, displayText: string): string {
	if (!isHyperlinkEnabled()) return displayText;
	return wrapHyperlinkCore(uri, displayText, ST);
}

export function uriHyperlink(uri: string, displayText: string): string {
	return wrapHyperlink(uri, displayText);
}

export function urlHyperlink(url: string, displayText: string): string {
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlink(parsed.href, displayText);
	} catch {
		return displayText;
	}
}

export function urlHyperlinkAlways(url: string, displayText: string): string {
	if (!isSettingsInitialized()) return displayText;
	if (settings.get("tui.hyperlinks") === "off") return displayText;
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlinkCore(parsed.href, displayText, BEL);
	} catch {
		return displayText;
	}
}

export function fileHyperlink(filePath: string, displayText: string, opts?: { line?: number; col?: number }): string {
	return wrapHyperlink(buildFileUri(filePath, opts), displayText);
}

export function tryResolveInternalUrlSync(input: string): string | undefined {
	try {
		if (input.startsWith("local://")) {
			const opts = LocalProtocolHandler.resolveOptions();
			if (!opts) return undefined;
			return resolveLocalUrlToPath(input, opts);
		}
	} catch {
		return undefined;
	}
	return undefined;
}
