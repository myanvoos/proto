import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { BROWSER_PROTOCOL_TIMEOUT_MS } from "../launch";
import type { ExtToRelayMessage, RelayRpcRequest, RelayToExtMessage, TabSnapshot } from "./protocol";
import {
	DISCARDED_TABS_PROTOCOL_VERSION,
	EXTENSION_RELOAD_PROTOCOL_VERSION,
	isOlderProtoVersion,
	isProtoVersion,
} from "./protocol";

export type RelayBridgeExtensionUpdater = (extensionId: string) => Promise<boolean>;

export interface RelaySocket {
	send(text: string): void;
	close(): void;
}

interface CdpCommand {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

interface SessionRef {
	kind: "tab" | "page";
	tabId: number;
	autoAttach: boolean;
	interceptsFileChooser: boolean;
}

interface TargetInfo {
	targetId: string;
	type: "tab" | "page" | "browser";
	title: string;
	url: string;
	attached: boolean;
	canAccessOpener: boolean;
}

class CdpConnection {
	discover = false;
	autoAttach = false;

	readonly sessions = new Map<string, SessionRef>();

	readonly claims = new Set<number>();
	/** Real child session → the session it was announced on. */
	readonly childParents = new Map<string, string>();

	childTargetSessionForTab(tabId: number): string | undefined {
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabId === tabId && ref.kind === "page" && ref.autoAttach) return sessionId;
		}
		return undefined;
	}

	constructor(
		readonly id: number,
		readonly socket: RelaySocket,
	) {}

	sessionsForTab(tabId: number, kind?: "tab" | "page"): string[] {
		const out: string[] = [];
		for (const [sessionId, ref] of this.sessions) {
			if (ref.tabId === tabId && (!kind || ref.kind === kind)) out.push(sessionId);
		}
		return out;
	}
}

class TabState {
	url: string;
	title: string;
	active: boolean;
	discarded: boolean;
	windowId: number;
	pinned: boolean;

	groupId: number;

	attached = false;

	refusal: string | undefined;

	announced = false;
	attaching: Promise<boolean> | null = null;
	attachCancelled = false;
	attachGeneration = 0;
	cancelAttach: (() => void) | null = null;
	retryAttachAfterDiscard = false;
	detaching: Promise<void> | null = null;
	closing = false;
	chromeDetach = Promise.withResolvers<void>();

	grouped = false;

	grouping = false;
	ompGroupId: number | undefined;

	groupOptOut = false;

	readonly realSessions = new Map<string, { parent: string | undefined; event: Record<string, unknown> }>();

	constructor(
		readonly tabId: number,
		snap: TabSnapshot,
	) {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.discarded = snap.discarded === true;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}

	update(snap: TabSnapshot): void {
		this.url = snap.url;
		this.title = snap.title;
		this.active = snap.active;
		this.discarded = snap.discarded === true;
		this.windowId = snap.windowId;
		this.pinned = snap.pinned;
		this.groupId = snap.groupId;
	}
}

const INELIGIBLE_URL = /^(chrome|devtools|edge|view-source|chrome-extension|chrome-untrusted|chrome-search):/i;

const RPC_TIMEOUT_MS = 20_000;
const PAGE_BOUND_RPC_TIMEOUT_MS = BROWSER_PROTOCOL_TIMEOUT_MS + 5_000;
const LATE_RPC_KEEP_MS = 60_000;
const DETACHED_COMMAND_ERROR = /Detached while handling command/;
const CHROME_DETACH_REPORT_MS = 1_000;
class RpcTimeoutError extends Error {}
class ExtensionReplacedError extends Error {}
const CDP_ERROR_METHOD_NOT_FOUND = -32601;
const CDP_ERROR_SERVER = -32000;

function tabTargetId(tabId: number): string {
	return `TAB${tabId}`;
}

function pageTargetId(tabId: number): string {
	return `PAGE${tabId}`;
}

function parseTargetId(targetId: string): { kind: "tab" | "page"; tabId: number } | null {
	const match = /^(TAB|PAGE)(\d+)$/.exec(targetId);
	if (!match) return null;
	return { kind: match[1] === "TAB" ? "tab" : "page", tabId: Number(match[2]) };
}

export class RelayBridge {
	#tabs = new Map<number, TabState>();
	#conns = new Map<number, CdpConnection>();
	#connSeq = 0;
	#sessionSeq = 0;
	#rpcSeq = 0;
	#ext: RelaySocket | null = null;
	#extInfo: {
		userAgent: string;
		browserVersion: string;
		discardedTabsProtocol?: number;
		protoVersion?: string;
		reloadProtocol?: number;
	} | null = null;
	#extensionId: string | null = null;
	#updating = false;
	#updateTried = new Set<string>();
	#updateExtension: RelayBridgeExtensionUpdater | null;
	#browserSession: string | undefined;
	#closeOnHello = new Map<number, { session: string; url: string }>();
	#extensionSeen = false;
	#extensionGoneSince: number | null = null;
	#lateRpc = new Map<number, { onResult: (result: unknown) => void; timer: NodeJS.Timeout }>();
	#interceptionTransitions = new Map<number, Promise<void>>();
	#pendingRpc = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();

	#realSessionTabs = new Map<string, number>();
	#log: (message: string, data?: Record<string, unknown>) => void;

	#group: { title: string; color: string } | null;

	#groupQueue: TabState[] = [];

	#groupDraining = false;

	constructor(
		opts: {
			log?: (message: string, data?: Record<string, unknown>) => void;

			group?: { title: string; color: string } | null;
			updateExtension?: RelayBridgeExtensionUpdater;
		} = {},
	) {
		this.#log = opts.log ?? (() => {});
		this.#group = opts.group ?? null;
		this.#updateExtension = opts.updateExtension ?? null;
	}

	get ready(): boolean {
		return this.#ext !== null && this.#extInfo !== null && !this.#updating;
	}

	get extensionSeen(): boolean {
		return this.#extensionSeen;
	}

	get extensionGoneForMs(): number | null {
		return this.#extensionGoneSince === null ? null : Date.now() - this.#extensionGoneSince;
	}

	get cdpClientCount(): number {
		return this.#conns.size;
	}

	versionInfo(wsUrl: string): Record<string, string | number> {
		const ua = this.#extInfo?.userAgent ?? "";
		return {
			Browser: this.#extInfo?.browserVersion ?? "Chrome/unknown",
			"Protocol-Version": "1.3",
			"User-Agent": ua,
			"V8-Version": "",
			"WebKit-Version": "",
			webSocketDebuggerUrl: wsUrl,
			protoRelayVersion: VERSION,
			protoRelayDiscardedTabsProtocol: String(DISCARDED_TABS_PROTOCOL_VERSION),
			protoExtensionDiscardedTabsProtocol: String(
				this.#extInfo?.discardedTabsProtocol === DISCARDED_TABS_PROTOCOL_VERSION
					? DISCARDED_TABS_PROTOCOL_VERSION
					: 0,
			),
			protoRelayCdpClients: this.#conns.size,
			protoExtensionVersion: this.#extInfo?.protoVersion ?? "",
		};
	}

	listTargets(): Array<Record<string, string>> {
		const out: Array<Record<string, string>> = [];
		for (const tab of this.#tabs.values()) {
			if (!this.#eligible(tab)) continue;
			out.push({
				id: pageTargetId(tab.tabId),
				type: "page",
				title: tab.title,
				url: tab.url,
				active: String(tab.active),
				discarded: String(tab.discarded),
			});
		}
		return out;
	}

	extConnected(socket: RelaySocket, extensionId?: string): void {
		if (this.#ext && this.#ext !== socket) {
			this.#log("replacing extension socket");
			const previous = this.#ext;
			this.extClosed(previous);
			previous.close();
		}
		this.#ext = socket;
		this.#extensionId = extensionId ?? null;
		this.#updating = false;
	}

	extClosed(socket: RelaySocket): void {
		if (this.#ext !== socket) return;
		this.#ext = null;
		this.#updating = false;
		this.#extInfo = null;
		if (this.#extensionSeen) this.#extensionGoneSince ??= Date.now();
		for (const pending of this.#pendingRpc.values()) {
			clearTimeout(pending.timer);
			pending.reject(new ExtensionReplacedError("relay extension disconnected"));
		}
		this.#pendingRpc.clear();
		for (const late of this.#lateRpc.values()) clearTimeout(late.timer);
		this.#lateRpc.clear();
		for (const tab of this.#tabs.values()) {
			tab.attached = false;
			tab.cancelAttach?.();
			tab.attachGeneration++;
			this.#forgetChildren(tab);

			tab.grouped = false;
			tab.grouping = false;
			tab.ompGroupId = undefined;
		}
		this.#groupQueue.length = 0;
	}

	extMessage(socket: RelaySocket, raw: string): void {
		if (socket !== this.#ext) return;
		let msg: ExtToRelayMessage;
		try {
			msg = JSON.parse(raw) as ExtToRelayMessage;
		} catch {
			this.#log("dropping malformed extension message");
			return;
		}
		switch (msg.t) {
			case "hello":
				this.#onHello(msg);
				return;
			case "rpcResult": {
				const pending = this.#pendingRpc.get(msg.id);
				if (!pending) {
					const late = this.#lateRpc.get(msg.id);
					if (!late) return;
					this.#lateRpc.delete(msg.id);
					clearTimeout(late.timer);
					if (msg.ok) late.onResult(msg.result);
					if (this.#conns.size === 0) void this.#updateIdleExtension();
					return;
				}
				this.#pendingRpc.delete(msg.id);
				clearTimeout(pending.timer);
				if (msg.ok) pending.resolve(msg.result);
				else pending.reject(new Error(msg.error ?? "extension rpc failed"));
				return;
			}
			case "cdpEvent":
				this.#onCdpEvent(msg.tabId, msg.sessionId, msg.method, msg.params);
				return;
			case "detached":
				this.#onTabDetached(msg.tabId, msg.reason, msg.relayInitiated === true);
				return;
			case "tabCreated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabUpdated":
				this.#onTabUpsert(msg.tab);
				return;
			case "tabRemoved":
				this.#onTabRemoved(msg.tabId);
				return;
			case "ping":
				socket.send(JSON.stringify({ t: "pong" } satisfies RelayToExtMessage));
				return;
		}
	}

	#onHello(msg: Extract<ExtToRelayMessage, { t: "hello" }>): void {
		this.#extInfo = {
			userAgent: msg.userAgent,
			browserVersion: msg.browserVersion,
			discardedTabsProtocol: msg.discardedTabsProtocol,
			protoVersion: msg.protoVersion,
			reloadProtocol: msg.reloadProtocol,
		};
		this.#browserSession = msg.browserSession;
		this.#extensionSeen = true;
		this.#extensionGoneSince = null;
		const seen = new Set<number>();
		const attachedNow = new Set(msg.attachedTabIds);
		for (const snap of msg.tabs) {
			seen.add(snap.tabId);
			this.#onTabUpsert(snap, { silent: true });
		}
		for (const tabId of [...this.#tabs.keys()]) {
			if (!seen.has(tabId)) this.#onTabRemoved(tabId);
		}
		for (const tab of this.#tabs.values()) {
			const wasAttached = tab.attached;
			tab.attached = attachedNow.has(tab.tabId);
			if (!tab.attached) this.#forgetChildren(tab);
			if (tab.discarded) {
				this.#retractTab(tab);
				this.#detachIfUnheld(tab.tabId);
				continue;
			}

			if (wasAttached && !tab.attached && this.#sessionHolders(tab.tabId).length > 0) {
				void this.#ensureAttached(tab).then(ok => {
					if (!ok) this.#onTabDetached(tab.tabId, "reattach_failed");
				});
			}
		}
		for (const [tabId, close] of this.#closeOnHello) {
			const tab = this.#tabs.get(tabId);
			if (!tab || close.session !== msg.browserSession || close.url !== tab.url) {
				this.#closeOnHello.delete(tabId);
				continue;
			}
			void this.#closeTab(tabId).catch(() => {});
		}
		this.#syncGrouping();
		this.#log("extension connected", { tabs: this.#tabs.size, version: msg.browserVersion });
		this.#maybeUpdateExtension();
	}

	#reloadBlocker(): boolean {
		if (
			!this.#ext ||
			this.#conns.size > 0 ||
			this.#pendingRpc.size > 0 ||
			this.#lateRpc.size > 0 ||
			this.#closeOnHello.size > 0
		)
			return true;
		return [...this.#tabs.values()].some(tab => tab.attached || tab.attaching || tab.detaching || tab.closing);
	}

	#maybeUpdateExtension(): void {
		const update = this.#updateExtension;
		const extensionId = this.#extensionId;
		const from = this.#extInfo?.protoVersion ?? "";
		const key = `${extensionId}:${from}`;
		if (!update || !extensionId || this.#updating || this.#updateTried.has(key)) return;
		if (
			this.#extInfo?.reloadProtocol !== EXTENSION_RELOAD_PROTOCOL_VERSION ||
			!isProtoVersion(from) ||
			!isOlderProtoVersion(from, VERSION) ||
			this.#reloadBlocker()
		)
			return;
		const socket = this.#ext!;
		this.#updating = true;
		void update(extensionId)
			.catch(error => {
				this.#log("extension update failed", { error: String(error) });
				return false;
			})
			.then(updated => {
				if (this.#ext !== socket || !this.#updating) return;
				if (!updated || this.#reloadBlocker()) {
					this.#updating = false;
					return;
				}
				this.#updateTried.add(key);
				socket.send(JSON.stringify({ t: "reload" } satisfies RelayToExtMessage));
				socket.close();
				this.extClosed(socket);
			});
	}

	async #updateIdleExtension(): Promise<void> {
		const awaited = new Set<Promise<unknown>>();
		for (;;) {
			const busy = [...this.#tabs.values()]
				.map(tab => tab.attaching ?? tab.detaching)
				.filter((p): p is Promise<boolean> | Promise<void> => p !== null && !awaited.has(p));
			if (busy.length === 0) break;
			for (const promise of busy) awaited.add(promise);
			await Promise.all(busy);
		}
		if (this.#conns.size === 0) this.#maybeUpdateExtension();
	}

	cdpConnected(socket: RelaySocket): number {
		const conn = new CdpConnection(++this.#connSeq, socket);
		this.#conns.set(conn.id, conn);
		this.#log("cdp client connected", { conn: conn.id });
		return conn.id;
	}

	cdpClosed(connId: number): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		this.#conns.delete(connId);
		const touched = new Set<number>();
		const intercepting = new Set<number>();
		for (const ref of conn.sessions.values()) {
			touched.add(ref.tabId);
			if (ref.interceptsFileChooser) intercepting.add(ref.tabId);
		}
		conn.sessions.clear();
		conn.childParents.clear();
		for (const tabId of intercepting) this.#releaseFileChooserInterception(tabId);

		for (const tabId of conn.claims) {
			const tab = this.#tabs.get(tabId);
			if (tab) this.#syncTabGrouping(tab);
		}
		conn.claims.clear();

		for (const tabId of touched) this.#detachIfUnheld(tabId);
		this.#log("cdp client closed", { conn: connId });
		if (this.#conns.size === 0) void this.#updateIdleExtension();
	}

	cdpMessage(connId: number, raw: string): void {
		const conn = this.#conns.get(connId);
		if (!conn) return;
		let msg: CdpCommand;
		try {
			msg = JSON.parse(raw) as CdpCommand;
		} catch {
			return;
		}
		if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
		void this.#handleCdpCommand(conn, msg).catch(err => {
			this.#replyError(conn, msg, err instanceof Error ? err.message : String(err));
		});
	}

	async #handleCdpCommand(conn: CdpConnection, msg: CdpCommand): Promise<void> {
		const sessionId = msg.sessionId;
		if (!sessionId) {
			await this.#handleBrowserCommand(conn, msg);
			return;
		}
		const ref = conn.sessions.get(sessionId);
		if (ref?.kind === "tab") {
			this.#handleTabSessionCommand(conn, msg, ref);
			return;
		}
		if (ref?.kind === "page") {
			if (msg.method === "Target.setAutoAttach") {
				const previous = ref.autoAttach;
				ref.autoAttach = msg.params?.autoAttach === true;
				const announce = () => {
					const parent = conn.childTargetSessionForTab(ref.tabId);
					if (parent && conn.sessions.get(sessionId) === ref)
						this.#announceChildren(conn, ref.tabId, undefined, parent);
				};
				if (!(await this.#forwardToTab(conn, msg, ref.tabId, undefined, ref.autoAttach ? announce : undefined)))
					ref.autoAttach = previous;
				return;
			}
			if (msg.method === "Page.setInterceptFileChooserDialog") {
				await this.#serializeInterception(ref.tabId, async () => {
					if (conn.sessions.get(sessionId) !== ref) {
						this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
						return;
					}
					const previous = ref.interceptsFileChooser;
					ref.interceptsFileChooser = msg.params?.enabled === true;
					const params = { ...msg.params, enabled: this.#interceptsFileChooser(ref.tabId) };
					if (!(await this.#forwardToTab(conn, { ...msg, params }, ref.tabId, undefined)))
						ref.interceptsFileChooser = previous;
				});
				return;
			}
			await this.#forwardToTab(conn, msg, ref.tabId, undefined);
			return;
		}
		const realTab = this.#realSessionTabs.get(sessionId);
		if (realTab !== undefined && conn.childParents.has(sessionId)) {
			const announce =
				msg.method === "Target.setAutoAttach" && msg.params?.autoAttach === true
					? () => this.#announceChildren(conn, realTab, sessionId, sessionId)
					: undefined;
			await this.#forwardToTab(conn, msg, realTab, sessionId, announce);
			return;
		}
		this.#replyError(conn, msg, `Unknown session id ${sessionId}`);
	}

	#announceChildren(conn: CdpConnection, tabId: number, parent: string | undefined, sessionId: string): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		for (const [child, known] of tab.realSessions) {
			if (known.parent !== parent || conn.childParents.has(child)) continue;
			conn.childParents.set(child, sessionId);
			this.#emit(conn, "Target.attachedToTarget", known.event, sessionId);
		}
	}

	async #forwardToTab(
		conn: CdpConnection,
		msg: CdpCommand,
		tabId: number,
		realSessionId: string | undefined,
		beforeReply?: () => void,
	): Promise<boolean> {
		if (msg.method === "Browser.close") {
			this.#reply(conn, msg, {});
			return true;
		}
		if (msg.method === "PROTO.claimTarget") {
			this.#claimTab(conn, tabId);
			this.#reply(conn, msg, {});
			return true;
		}
		const tab = this.#tabs.get(tabId);
		if (!tab) {
			this.#replyError(conn, msg, `No tab with id ${tabId}`);
			return false;
		}
		if (
			msg.method === "Target.createTarget" ||
			msg.method === "Target.closeTarget" ||
			msg.method === "Target.activateTarget"
		) {
			await this.#handleBrowserCommand(conn, msg, tab);
			return true;
		}
		try {
			const pageBound =
				msg.params?.awaitPromise === true ||
				msg.method === "Runtime.awaitPromise" ||
				msg.method === "Page.navigate";
			const timeoutMs = pageBound ? PAGE_BOUND_RPC_TIMEOUT_MS : RPC_TIMEOUT_MS;
			const result = await this.#rpc(
				{ op: "send", tabId, sessionId: realSessionId, method: msg.method, params: msg.params },
				timeoutMs,
			).catch(error => {
				if (!(error instanceof RpcTimeoutError)) throw error;
				throw new Error(`${msg.method} on tab ${tabId}: Chrome sent no answer within ${timeoutMs}ms`, {
					cause: error,
				});
			});
			beforeReply?.();
			this.#reply(conn, msg, (result as Record<string, unknown> | undefined) ?? {});
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (realSessionId === undefined && tab.attached && DETACHED_COMMAND_ERROR.test(message)) {
				await Promise.race([tab.chromeDetach.promise, Bun.sleep(CHROME_DETACH_REPORT_MS)]);
			}
			this.#replyError(conn, msg, message);
			return false;
		}
	}

	#claimTab(conn: CdpConnection, tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		if (!conn.claims.has(tabId)) {
			conn.claims.add(tabId);
			this.#log("tab claimed", { conn: conn.id, tabId });
		}
		this.#syncTabGrouping(tab);
	}

	#claimed(tabId: number): boolean {
		for (const conn of this.#conns.values()) {
			if (conn.claims.has(tabId)) return true;
		}
		return false;
	}

	#handleTabSessionCommand(conn: CdpConnection, msg: CdpCommand, ref: SessionRef): void {
		switch (msg.method) {
			case "Target.setAutoAttach": {
				const tab = this.#tabs.get(ref.tabId);
				if (!tab) {
					this.#replyError(conn, msg, `Tab ${ref.tabId} is gone`);
					return;
				}

				const pageSession = this.#mintSession(conn, "page", tab.tabId);
				this.#emit(
					conn,
					"Target.attachedToTarget",
					{
						sessionId: pageSession,
						targetInfo: this.#pageInfo(tab, true),
						waitingForDebugger: false,
					},
					msg.sessionId,
				);
				this.#reply(conn, msg, {});
				return;
			}
			case "Runtime.runIfWaitingForDebugger":
				this.#reply(conn, msg, {});
				return;
			case "Target.detachFromTarget": {
				const child = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (child) this.#releaseSession(conn, child, msg.sessionId);
				this.#reply(conn, msg, {});
				return;
			}
			default:
				this.#replyError(conn, msg, `'${msg.method}' is not supported on a tab target`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	async #handleBrowserCommand(conn: CdpConnection, msg: CdpCommand, near?: TabState): Promise<void> {
		switch (msg.method) {
			case "Browser.getVersion": {
				this.#reply(conn, msg, {
					protocolVersion: "1.3",
					product: this.#extInfo?.browserVersion ?? "Chrome/unknown",
					revision: "",
					userAgent: this.#extInfo?.userAgent ?? "",
					jsVersion: "",
				});
				return;
			}
			case "Target.getTargets": {
				const targetInfos: TargetInfo[] = [];
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab)) continue;
					targetInfos.push(this.#tabInfo(tab, tab.attached), this.#pageInfo(tab, tab.attached));
				}
				this.#reply(conn, msg, { targetInfos });
				return;
			}
			case "Target.getBrowserContexts":
				this.#reply(conn, msg, { browserContextIds: [] });
				return;
			case "Target.setDiscoverTargets": {
				conn.discover = true;
				for (const tab of this.#tabs.values()) {
					if (!this.#eligible(tab)) continue;
					tab.announced = true;
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
					this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.setAutoAttach": {
				conn.autoAttach = true;
				const tabs = [...this.#tabs.values()].filter(tab => this.#eligible(tab) && !tab.discarded);
				await Promise.all(tabs.map(tab => this.#ensureAttached(tab, { retryAfterDiscard: true })));
				for (const tab of tabs) {
					if (!tab.attached || tab.discarded || !this.#eligible(tab)) {
						this.#retractTab(tab);
						this.#detachIfUnheld(tab.tabId);
						continue;
					}
					this.#emitTabAttached(conn, tab);
				}
				for (const tab of this.#tabs.values()) {
					if (tab.announced && tab.discarded) {
						this.#retractTab(tab);
						this.#detachIfUnheld(tab.tabId);
					}
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.attachToTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (!parsed || !tab) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				if (tab.discarded) {
					this.#replyError(conn, msg, `Cannot attach to discarded tab ${tab.tabId}`);
					return;
				}
				if (!(await this.#ensureAttached(tab))) {
					const reason = tab.refusal ? `: ${tab.refusal}` : "";
					this.#replyError(conn, msg, `Cannot attach to tab ${tab.tabId} (${tab.url})${reason}`);
					return;
				}
				const sessionId = this.#mintSession(conn, parsed.kind, tab.tabId);
				const info = parsed.kind === "tab" ? this.#tabInfo(tab, true) : this.#pageInfo(tab, true);
				this.#emit(conn, "Target.attachedToTarget", { sessionId, targetInfo: info, waitingForDebugger: false });
				this.#reply(conn, msg, { sessionId });
				return;
			}
			case "Target.detachFromTarget": {
				const sessionId = typeof msg.params?.sessionId === "string" ? msg.params.sessionId : undefined;
				if (sessionId) this.#releaseSession(conn, sessionId, undefined);
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.createTarget": {
				const url =
					typeof msg.params?.url === "string" && msg.params.url.length > 0 ? msg.params.url : "about:blank";
				const origin = this.#ext;
				const active = msg.params?.background === true ? false : undefined;
				const result = (await this.#rpc({ op: "createTab", url, active }, RPC_TIMEOUT_MS, late => {
					if (this.#ext !== origin) return;
					const created = late as { tab: TabSnapshot };
					void this.#closeTab(created.tab.tabId).catch(error =>
						this.#log("late relay tab close failed", { error: String(error) }),
					);
				})) as { tab: TabSnapshot };
				if (this.#ext !== origin) throw new ExtensionReplacedError("relay extension replaced during tab creation");
				this.#onTabUpsert(result.tab);
				if (this.#conns.get(conn.id) !== conn) {
					await this.#closeTab(result.tab.tabId);
					return;
				}
				this.#claimTab(conn, result.tab.tabId);
				const created = this.#tabs.get(result.tab.tabId);
				if (conn.autoAttach && created && !(await this.#ensureAttached(created)) && created.refusal) {
					const refusal = created.refusal;
					await this.#closeTab(created.tabId).catch(() => {});
					this.#replyError(conn, msg, `Chrome refused to attach to the new tab: ${refusal}`);
					return;
				}
				if (this.#conns.get(conn.id) !== conn) {
					await this.#closeTab(result.tab.tabId);
					return;
				}
				this.#reply(conn, msg, { targetId: pageTargetId(result.tab.tabId) });
				return;
			}
			case "Target.closeTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (!parsed || !this.#tabs.has(parsed.tabId)) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				await this.#closeTab(parsed.tabId);
				this.#reply(conn, msg, { success: true });
				return;
			}
			case "Target.activateTarget": {
				const parsed = typeof msg.params?.targetId === "string" ? parseTargetId(msg.params.targetId) : null;
				if (parsed && this.#tabs.has(parsed.tabId)) await this.#rpc({ op: "activateTab", tabId: parsed.tabId });
				else if (near) {
					this.#replyError(conn, msg, `No target with id ${String(msg.params?.targetId)}`);
					return;
				}
				this.#reply(conn, msg, {});
				return;
			}
			case "Target.getTargetInfo": {
				const raw = typeof msg.params?.targetId === "string" ? msg.params.targetId : undefined;
				const parsed = raw ? parseTargetId(raw) : null;
				const tab = parsed ? this.#tabs.get(parsed.tabId) : undefined;
				if (parsed && tab) {
					const info =
						parsed.kind === "tab" ? this.#tabInfo(tab, tab.attached) : this.#pageInfo(tab, tab.attached);
					this.#reply(conn, msg, { targetInfo: info });
					return;
				}
				this.#reply(conn, msg, {
					targetInfo: {
						targetId: "relay-browser",
						type: "browser",
						title: "",
						url: "",
						attached: true,
						canAccessOpener: false,
					} satisfies TargetInfo,
				});
				return;
			}
			case "Browser.close":
				this.#log("refusing Browser.close from downstream client", { conn: conn.id });
				this.#reply(conn, msg, {});
				return;
			case "Browser.setDownloadBehavior":
				this.#reply(conn, msg, {});
				return;
			case "Target.createBrowserContext":
				this.#replyError(conn, msg, "Browser contexts are not supported by the proto browser relay");
				return;
			default:
				this.#replyError(conn, msg, `'${msg.method}' wasn't found`, CDP_ERROR_METHOD_NOT_FOUND);
		}
	}

	#onCdpEvent(
		tabId: number,
		sourceSessionId: string | undefined,
		method: string,
		params?: Record<string, unknown>,
	): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		const child = typeof params?.sessionId === "string" ? params.sessionId : undefined;
		if (child && method === "Target.attachedToTarget" && params) {
			tab.realSessions.set(child, { parent: sourceSessionId, event: params });
			this.#realSessionTabs.set(child, tabId);
		} else if (child && method === "Target.detachedFromTarget") {
			tab.realSessions.delete(child);
			this.#realSessionTabs.delete(child);
		}
		if (sourceSessionId) {
			for (const conn of this.#conns.values()) {
				if (!conn.childParents.has(sourceSessionId)) continue;
				this.#emit(conn, method, params ?? {}, sourceSessionId);
				if (child && method === "Target.attachedToTarget") conn.childParents.set(child, sourceSessionId);
				else if (child && method === "Target.detachedFromTarget") conn.childParents.delete(child);
			}
			return;
		}
		if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
			if (!child) return;
			for (const conn of this.#conns.values()) {
				let parent: string | undefined;
				if (method === "Target.attachedToTarget") {
					if (conn.childParents.has(child)) continue;
					parent = conn.childTargetSessionForTab(tabId);
					if (parent) conn.childParents.set(child, parent);
				} else {
					parent = conn.childParents.get(child);
					conn.childParents.delete(child);
				}
				if (parent) this.#emit(conn, method, params ?? {}, parent);
			}
			return;
		}
		for (const conn of this.#conns.values()) {
			for (const pageSession of conn.sessionsForTab(tabId, "page"))
				this.#emit(conn, method, params ?? {}, pageSession);
		}
	}

	#onTabDetached(tabId: number, reason: string, relayInitiated = false): void {
		const tab = this.#tabs.get(tabId);
		if (!tab || relayInitiated) return;
		this.#log("tab detached", { tabId, reason });
		tab.attached = false;
		tab.attachGeneration++;
		tab.cancelAttach?.();
		const cancelledByUser = reason === "canceled_by_user";
		if (cancelledByUser) tab.refusal = "the user cancelled Chrome's debugging bar";
		this.#syncTabGrouping(tab);
		if (!tab.closing) {
			for (const conn of this.#conns.values()) {
				for (const pageSession of conn.sessionsForTab(tabId, "page"))
					this.#emit(conn, "PROTO.debuggerDetached", { reason }, pageSession);
			}
		}
		tab.chromeDetach.resolve();
		tab.chromeDetach = Promise.withResolvers<void>();
		this.#retractTab(tab);
		if (!cancelledByUser && !tab.closing && !tab.discarded && this.#eligible(tab)) this.#announceTab(tab);
	}

	#onTabRemoved(tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		this.#retractTab(tab);
		this.#tabs.delete(tabId);
		this.#closeOnHello.delete(tabId);
		for (const conn of this.#conns.values()) conn.claims.delete(tabId);
	}

	#onTabUpsert(snap: TabSnapshot, opts: { silent?: boolean } = {}): void {
		let tab = this.#tabs.get(snap.tabId);
		if (!tab) {
			tab = new TabState(snap.tabId, snap);
			this.#tabs.set(snap.tabId, tab);
		} else {
			if (tab.url !== snap.url) tab.refusal = undefined;
			if (tab.grouped && tab.ompGroupId !== undefined && snap.groupId !== tab.ompGroupId) {
				tab.grouped = false;
				tab.groupOptOut = true;
			}
			tab.update(snap);
			if (tab.discarded && tab.attaching && !tab.attachCancelled) {
				tab.attachGeneration++;
				tab.attachCancelled = true;
				tab.cancelAttach?.();
			}
		}
		if (snap.active) {
			for (const other of this.#tabs.values()) {
				if (other !== tab && other.windowId === snap.windowId) other.active = false;
			}
		}
		if (opts.silent) return;
		const eligible = this.#eligible(tab);
		this.#syncTabGrouping(tab);
		if (eligible && !tab.announced && !tab.discarded) {
			this.#announceTab(tab);
			return;
		}
		if ((!eligible || tab.discarded) && tab.announced) {
			this.#retractTab(tab);
			this.#detachIfUnheld(tab.tabId);
			return;
		}
		if (eligible && tab.announced) {
			for (const conn of this.#conns.values()) {
				if (!conn.discover) continue;
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#tabInfo(tab, tab.attached) });
				this.#emit(conn, "Target.targetInfoChanged", { targetInfo: this.#pageInfo(tab, tab.attached) });
			}
		}
	}

	#announceTab(tab: TabState): void {
		tab.announced = true;
		for (const conn of this.#conns.values()) {
			if (!conn.discover) continue;
			this.#emit(conn, "Target.targetCreated", { targetInfo: this.#tabInfo(tab, tab.attached) });
			this.#emit(conn, "Target.targetCreated", { targetInfo: this.#pageInfo(tab, tab.attached) });
		}
		this.#attachForAutoAttach(tab);
	}

	#attachForAutoAttach(tab: TabState): void {
		if (![...this.#conns.values()].some(conn => conn.autoAttach)) return;
		void this.#ensureAttached(tab, { retryAfterDiscard: true }).then(ok => {
			if (!ok) {
				if (tab.refusal && tab.announced && this.#tabs.get(tab.tabId) === tab) this.#retractTab(tab);
				return;
			}
			if (tab.discarded || !this.#eligible(tab) || this.#tabs.get(tab.tabId) !== tab) {
				this.#retractTab(tab);
				this.#detachIfUnheld(tab.tabId);
				return;
			}
			for (const conn of this.#conns.values()) if (conn.autoAttach) this.#emitTabAttached(conn, tab);
		});
	}

	#groupWorthy(tab: TabState): boolean {
		if (!this.#claimed(tab.tabId) || !this.#eligible(tab) || tab.pinned || tab.groupOptOut) return false;
		return tab.grouped || tab.groupId === -1;
	}

	#syncGrouping(): void {
		if (!this.#group) return;
		const worthy = [...this.#tabs.values()].filter(tab => this.#groupWorthy(tab) && !tab.grouped && !tab.grouping);
		if (worthy.length > 0) this.#requestGroup(worthy);
	}

	#syncTabGrouping(tab: TabState): void {
		if (!this.#group) return;
		if (this.#groupWorthy(tab)) {
			if (!tab.grouped && !tab.grouping) this.#requestGroup([tab]);
			return;
		}
		if (tab.grouped) {
			tab.grouped = false;
			tab.ompGroupId = undefined;
			void this.#rpc({ op: "ungroup", tabIds: [tab.tabId] }).catch(() => {});
		}
	}

	#requestGroup(tabs: TabState[]): void {
		if (!this.#group) return;
		for (const tab of tabs) {
			tab.grouping = true;
			this.#groupQueue.push(tab);
		}
		if (!this.#groupDraining) void this.#drainGroupQueue();
	}

	async #drainGroupQueue(): Promise<void> {
		const group = this.#group;
		if (!group) return;
		this.#groupDraining = true;
		try {
			while (this.#groupQueue.length > 0) {
				const batch = this.#groupQueue.splice(0);
				const tabIds = batch.map(tab => tab.tabId);
				try {
					const result = await this.#rpc({ op: "group", tabIds, title: group.title, color: group.color });

					const grouped: Record<string, unknown> =
						result &&
						typeof result === "object" &&
						"grouped" in result &&
						result.grouped &&
						typeof result.grouped === "object"
							? (result.grouped as Record<string, unknown>)
							: {};
					for (const tab of batch) {
						const groupId = grouped[String(tab.tabId)];
						if (typeof groupId !== "number") continue;
						tab.grouped = true;
						tab.ompGroupId = groupId;
					}
					this.#log("grouped tabs", { tabIds, grouped });
				} catch (err) {
					this.#log("tab grouping failed", { error: err instanceof Error ? err.message : String(err) });
				} finally {
					for (const tab of batch) tab.grouping = false;
				}
			}
		} finally {
			this.#groupDraining = false;
		}
	}

	#retractTab(tab: TabState): void {
		this.#forgetChildren(tab);
		for (const conn of this.#conns.values()) {
			const tabSessions = conn.sessionsForTab(tab.tabId, "tab");
			for (const pageSession of conn.sessionsForTab(tab.tabId, "page")) {
				conn.sessions.delete(pageSession);
				this.#emit(
					conn,
					"Target.detachedFromTarget",
					{ sessionId: pageSession, targetId: pageTargetId(tab.tabId) },
					tabSessions[0],
				);
			}
			for (const tabSession of tabSessions) {
				conn.sessions.delete(tabSession);
				this.#emit(conn, "Target.detachedFromTarget", { sessionId: tabSession, targetId: tabTargetId(tab.tabId) });
			}
			if (conn.discover && tab.announced) {
				this.#emit(conn, "Target.targetDestroyed", { targetId: pageTargetId(tab.tabId) });
				this.#emit(conn, "Target.targetDestroyed", { targetId: tabTargetId(tab.tabId) });
			}
		}
		tab.announced = false;
	}

	#mintSession(conn: CdpConnection, kind: "tab" | "page", tabId: number): string {
		const sessionId = `S${kind === "tab" ? "T" : "P"}${tabId}.${conn.id}.${++this.#sessionSeq}`;
		conn.sessions.set(sessionId, { kind, tabId, autoAttach: false, interceptsFileChooser: false });
		return sessionId;
	}

	#releaseSession(conn: CdpConnection, sessionId: string, parentSessionId: string | undefined): void {
		const ref = conn.sessions.get(sessionId);
		if (!ref) return;
		conn.sessions.delete(sessionId);
		if (ref.interceptsFileChooser) this.#releaseFileChooserInterception(ref.tabId);
		this.#detachIfUnheld(ref.tabId);
		const targetId = ref.kind === "tab" ? tabTargetId(ref.tabId) : pageTargetId(ref.tabId);
		this.#emit(conn, "Target.detachedFromTarget", { sessionId, targetId }, parentSessionId);
	}

	#sessionHolders(tabId: number): CdpConnection[] {
		const out: CdpConnection[] = [];
		for (const conn of this.#conns.values()) {
			if (conn.sessionsForTab(tabId).length > 0) out.push(conn);
		}
		return out;
	}

	#emitTabAttached(conn: CdpConnection, tab: TabState): void {
		if (conn.sessionsForTab(tab.tabId, "tab").length > 0) return;
		const sessionId = this.#mintSession(conn, "tab", tab.tabId);
		this.#emit(conn, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.#tabInfo(tab, true),
			waitingForDebugger: false,
		});
	}

	#forgetChildren(tab: TabState): void {
		for (const child of [...tab.realSessions.keys()].reverse()) {
			this.#realSessionTabs.delete(child);
			for (const conn of this.#conns.values()) {
				const parent = conn.childParents.get(child);
				if (parent === undefined) continue;
				conn.childParents.delete(child);
				this.#emit(conn, "Target.detachedFromTarget", { sessionId: child }, parent);
			}
		}
		tab.realSessions.clear();
	}

	#detachIfUnheld(tabId: number): void {
		if (this.#sessionHolders(tabId).length > 0) return;
		const tab = this.#tabs.get(tabId);
		if (!tab?.attached) return;
		tab.attached = false;
		this.#forgetChildren(tab);
		const done = this.#rpc({ op: "detach", tabId })
			.then(
				() => {},
				() => {},
			)
			.finally(() => {
				if (tab.detaching === done) tab.detaching = null;
			});
		tab.detaching = done;
	}

	#interceptsFileChooser(tabId: number): boolean {
		for (const conn of this.#conns.values()) {
			for (const ref of conn.sessions.values()) if (ref.tabId === tabId && ref.interceptsFileChooser) return true;
		}
		return false;
	}

	#releaseFileChooserInterception(tabId: number): void {
		void this.#serializeInterception(tabId, async () => {
			if (this.#interceptsFileChooser(tabId) || !this.#tabs.get(tabId)?.attached) return;
			await this.#rpc({
				op: "send",
				tabId,
				method: "Page.setInterceptFileChooserDialog",
				params: { enabled: false },
			}).catch(() => {});
		});
	}

	#serializeInterception(tabId: number, run: () => Promise<void>): Promise<void> {
		const pending = this.#interceptionTransitions.get(tabId);
		const result = pending ? pending.then(run) : run();
		const tail = result.catch(() => {});
		this.#interceptionTransitions.set(tabId, tail);
		void tail.then(() => {
			if (this.#interceptionTransitions.get(tabId) === tail) this.#interceptionTransitions.delete(tabId);
		});
		return result;
	}

	async #ensureAttached(tab: TabState, opts: { retryAfterDiscard?: boolean } = {}): Promise<boolean> {
		if (tab.discarded) return false;
		while (tab.detaching) await tab.detaching;
		if (tab.discarded) return false;
		if (tab.attached) return true;
		if (!this.#eligible(tab)) return false;
		const origin = this.#ext;
		if (!origin) return false;
		if (tab.attaching) {
			if (tab.attachCancelled && opts.retryAfterDiscard) tab.retryAttachAfterDiscard = true;
			return await tab.attaching;
		}
		const generation = tab.attachGeneration;
		const cancelled = Promise.withResolvers<boolean>();
		const request = this.#rpc({ op: "attach", tabId: tab.tabId })
			.then(() => {
				if (this.#ext !== origin || this.#tabs.get(tab.tabId) !== tab) return false;
				tab.attached = true;
				if (tab.discarded || tab.attachCancelled) this.#detachIfUnheld(tab.tabId);
				return !tab.discarded && !tab.attachCancelled;
			})
			.catch(err => {
				const error = err instanceof Error ? err.message : String(err);
				this.#log("attach failed", { tabId: tab.tabId, url: tab.url, error });
				if (!(err instanceof ExtensionReplacedError) && generation === tab.attachGeneration)
					tab.refusal = error || "Chrome refused the attach";
				return false;
			})
			.finally(() => {
				if (tab.attaching === attempt) {
					tab.attaching = null;
					tab.cancelAttach = null;
					tab.attachCancelled = false;
				}
				const retry = tab.retryAttachAfterDiscard;
				tab.retryAttachAfterDiscard = false;
				if (retry && !tab.discarded) this.#attachForAutoAttach(tab);
				if (this.#conns.size === 0) {
					this.#detachIfUnheld(tab.tabId);
					void this.#updateIdleExtension();
				}
			});
		const attempt = Promise.race([request, cancelled.promise]);
		tab.attaching = attempt;
		tab.cancelAttach = () => cancelled.resolve(false);
		return await attempt;
	}

	#eligible(tab: TabState): boolean {
		if (tab.refusal) return false;
		if (!this.#ext || this.#extInfo?.discardedTabsProtocol !== DISCARDED_TABS_PROTOCOL_VERSION) return false;
		if (!tab.url) return true;
		return !INELIGIBLE_URL.test(tab.url);
	}

	#tabInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: tabTargetId(tab.tabId),
			type: "tab",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	#pageInfo(tab: TabState, attached: boolean): TargetInfo {
		return {
			targetId: pageTargetId(tab.tabId),
			type: "page",
			title: tab.title,
			url: tab.url || "about:blank",
			attached,
			canAccessOpener: false,
		};
	}

	#reply(conn: CdpConnection, msg: CdpCommand, result: Record<string, unknown>): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result }));
	}

	#replyError(conn: CdpConnection, msg: CdpCommand, message: string, code = CDP_ERROR_SERVER): void {
		conn.socket.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, error: { code, message } }));
	}

	#emit(conn: CdpConnection, method: string, params: Record<string, unknown>, sessionId?: string): void {
		conn.socket.send(JSON.stringify({ sessionId, method, params }));
	}

	async #closeTab(tabId: number): Promise<void> {
		const tab = this.#tabs.get(tabId);
		const session = this.#browserSession;
		if (tab) tab.closing = true;
		try {
			await this.#rpc({ op: "removeTab", tabId });
			this.#closeOnHello.delete(tabId);
			if (this.#conns.size === 0) void this.#updateIdleExtension();
		} catch (error) {
			if (tab) tab.closing = false;
			// Only this browser run may retry the close; tab ids are reused after a browser restart.
			if (tab && session) this.#closeOnHello.set(tabId, { session, url: tab.url });
			throw error;
		}
	}

	#rpc(req: RelayRpcRequest, timeoutMs = RPC_TIMEOUT_MS, onLateResult?: (result: unknown) => void): Promise<unknown> {
		const ext = this.#ext;
		if (!ext) return Promise.reject(new Error("relay extension is not connected"));
		const id = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pendingRpc.delete(id);
			if (onLateResult) {
				const expiry = setTimeout(() => {
					this.#lateRpc.delete(id);
					if (this.#conns.size === 0) void this.#updateIdleExtension();
				}, LATE_RPC_KEEP_MS);
				expiry.unref();
				this.#lateRpc.set(id, { onResult: onLateResult, timer: expiry });
			}
			reject(new RpcTimeoutError(`extension rpc '${req.op}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pendingRpc.set(id, { resolve, reject, timer });
		ext.send(JSON.stringify({ t: "rpc", id, ...req } satisfies RelayToExtMessage));
		void promise
			.catch(() => {})
			.then(() => {
				if (this.#conns.size === 0) void this.#updateIdleExtension();
			});
		return promise;
	}
}
