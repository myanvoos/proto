/**
 * Wire protocol between the relay server and the Chrome extension.
 *
 * The extension dials out to `ws://127.0.0.1:<port>/ext` and exchanges JSON
 * messages. The relay drives the extension with numbered RPCs; the extension
 * pushes tab lifecycle and `chrome.debugger` events as they happen.
 */

/** Minimal view of a Chrome tab shared between extension and relay. */
export interface TabSnapshot {
	tabId: number;
	url: string;
	title: string;
	active: boolean;
	/** Chrome discarded this tab; it reloads when activated. */
	discarded: boolean;
	windowId: number;
	/** Pinned tabs are never grouped (Chrome would silently unpin them). */
	pinned: boolean;
	/** Chrome tab group id; -1 when ungrouped. */
	groupId: number;
}

/** RPCs the relay may ask the extension to perform. */
export type RelayRpcRequest =
	| { op: "attach"; tabId: number }
	| { op: "detach"; tabId: number }
	| { op: "send"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	/** `active: false` opens the tab without selecting it; absent keeps Chrome's default (selected). */
	| { op: "createTab"; url: string; active?: boolean }
	| { op: "removeTab"; tabId: number }
	| { op: "activateTab"; tabId: number }
	/** Add tabs to the per-window proto group (created/reused by title), remembering prior membership. */
	| { op: "group"; tabIds: number[]; title: string; color: string }
	/** Return tabs to their pre-proto group (or ungroup); no-op for tabs the relay never grouped. */
	| { op: "ungroup"; tabIds: number[] };

/**
 * Messages sent relay → extension. `reload` asks the extension to run `chrome.runtime.reload()`, which
 * re-reads its files from disk; the relay sends it only after rewriting them (extension self-update).
 */
export type RelayToExtMessage = ({ t: "rpc"; id: number } & RelayRpcRequest) | { t: "pong" } | { t: "reload" };

/** Required capability for safe relay target discovery and auto-attach. */
export const DISCARDED_TABS_PROTOCOL_VERSION = 1;

/** Hello capability of an extension that reloads itself on a relay `reload` message. */
export const EXTENSION_RELOAD_PROTOCOL_VERSION = 1;

/**
 * Whether a relay or extension reported a well-formed proto release version.
 * Stricter than `Bun.semver.order`, which ranks strings with trailing text;
 * peers supply these and results quote them.
 */
export function isProtoVersion(version: string): boolean {
	return /^(?=.{5,64}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version);
}

/**
 * Whether a reported proto version is provably older than `than`: unreported ("")
 * is older than anything reported; otherwise both must be proto versions, since
 * anything else has no known age.
 */
export function isOlderProtoVersion(version: string, than: string): boolean {
	if (version === "") return than !== "";
	return isProtoVersion(version) && isProtoVersion(than) && Bun.semver.order(version, than) < 0;
}

/**
 * The extension's service worker script with `protoVersion` declared above it as `PROTO_INSTALL_VERSION`, which the
 * extension reports in its hello. The stamp sits in the script, not only the manifest, because after the files
 * change a Chrome restart re-reads manifest.json but keeps running the service worker it registered before.
 */
export function stampRelayExtensionScript(script: string, protoVersion: string): string {
	return `const PROTO_INSTALL_VERSION = ${JSON.stringify(protoVersion)};\n${script}`;
}

/** The extension's manifest text with `protoVersion` as its `version_name`, which chrome://extensions shows. */
export function stampRelayExtensionManifest(manifestJson: string, protoVersion: string): string {
	return `${JSON.stringify({ ...JSON.parse(manifestJson), version_name: protoVersion }, null, "\t")}\n`;
}

/** Messages sent extension → relay. */
export type ExtToRelayMessage =
	| {
			t: "hello";
			/** Browser-run identity; closes queued in this relay never cross browser restarts. */
			browserSession?: string;
			userAgent: string;
			browserVersion: string;
			tabs: TabSnapshot[];
			/** Tabs that already have a `chrome.debugger` attachment (relay reconciles after a service-worker restart). */
			attachedTabIds: number[];
			/** Present when snapshots include Chrome's discarded state. Absent in older extensions. */
			discardedTabsProtocol?: number;
			/** The proto version that installed the running script ({@link stampRelayExtensionScript}). Absent on builds without the stamp. */
			protoVersion?: string;
			/** {@link EXTENSION_RELOAD_PROTOCOL_VERSION} when the extension reloads itself on `reload`. Absent in older extensions. */
			reloadProtocol?: number;
	  }
	| { t: "cdpEvent"; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
	| { t: "detached"; tabId: number; reason: string; relayInitiated?: boolean }
	| { t: "tabCreated"; tab: TabSnapshot }
	| { t: "tabUpdated"; tab: TabSnapshot }
	| { t: "tabRemoved"; tabId: number }
	| { t: "rpcResult"; id: number; ok: boolean; result?: unknown; error?: string }
	| { t: "ping" };
