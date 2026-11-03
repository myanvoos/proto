
import { DISCARDED_TABS_PROTOCOL_VERSION, EXTENSION_RELOAD_PROTOCOL_VERSION, type ExtToRelayMessage, type RelayToExtMessage, type TabSnapshot } from "../../coding-agent/src/tools/browser/relay/protocol";
import { ownedDebuggerTabs } from "./debugger-ownership";

declare const PROTO_INSTALL_VERSION: string | undefined;
const relayDetaches = new Set<number>();

const DEFAULT_PORT = 9224;
const PING_INTERVAL_MS = 20_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

let browserSession: Promise<string> | null = null;
function ensureBrowserSession(): Promise<string> {
	browserSession ??= (async () => {
		const stored = await chrome.storage.session.get({ relayBrowserSession: "" });
		if (typeof stored.relayBrowserSession === "string" && stored.relayBrowserSession) return stored.relayBrowserSession;
		const created = crypto.randomUUID();
		await chrome.storage.session.set({ relayBrowserSession: created });
		return created;
	})();
	return browserSession;
}

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer: NodeJS.Timeout | null = null;

interface RelaySettings {
	port: number;
	token: string;
}

async function loadSettings(): Promise<RelaySettings> {
	const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: "" });
	const port = Number(stored.port);
	return {
		port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT,
		token: typeof stored.token === "string" ? stored.token : "",
	};
}

function snapshot(tab: ChromeTab): TabSnapshot | null {
	if (tab.id === undefined) return null;
	return {
		tabId: tab.id,
		url: tab.url ?? tab.pendingUrl ?? "",
		title: tab.title ?? "",
		active: tab.active,
		discarded: tab.discarded === true,
		windowId: tab.windowId,
		pinned: tab.pinned,
		groupId: tab.groupId,
	};
}


let ompGroupTitle: string | null = null;


let groupOps: Promise<unknown> = Promise.resolve();
function enqueueGroupOp<T>(fn: () => Promise<T>): Promise<T> {
	const result = groupOps.then(fn, fn);
	groupOps = result.catch(() => {});
	return result;
}


async function groupTabs(tabIds: number[], title: string, color: string): Promise<{ grouped: Record<string, number> }> {
	ompGroupTitle = title;
	void chrome.storage.session.set({ ompGroupTitle: title });
	const byWindow = new Map<number, number[]>();
	for (const tabId of tabIds) {
		try {
			const tab = await chrome.tabs.get(tabId);

			if (tab.pinned || tab.id === undefined) continue;
			const bucket = byWindow.get(tab.windowId) ?? [];
			bucket.push(tab.id);
			byWindow.set(tab.windowId, bucket);
		} catch {

		}
	}
	const grouped: Record<string, number> = {};
	for (const [windowId, ids] of byWindow) {
		const existing = await chrome.tabGroups.query({ title, windowId });
		let groupId: number;
		if (existing[0]) {
			groupId = existing[0].id;

			for (const dupe of existing.slice(1)) {
				const dupeTabs = await chrome.tabs.query({ groupId: dupe.id });
				const dupeIds = dupeTabs.map(tab => tab.id).filter(id => id !== undefined);
				if (dupeIds.length > 0) await chrome.tabs.group({ tabIds: dupeIds, groupId });
			}
			await chrome.tabs.group({ tabIds: ids, groupId });
		} else {
			groupId = await chrome.tabs.group({ tabIds: ids });
		}
		await chrome.tabGroups.update(groupId, { title, color });
		for (const id of ids) grouped[String(id)] = groupId;
	}
	return { grouped };
}


async function restoreGroups(): Promise<void> {
	if (!ompGroupTitle) {

		const stored = await chrome.storage.session.get({ ompGroupTitle: "" }).catch(() => ({ ompGroupTitle: "" }));
		ompGroupTitle = typeof stored.ompGroupTitle === "string" && stored.ompGroupTitle ? stored.ompGroupTitle : null;
	}
	if (!ompGroupTitle) return;
	const groups = await chrome.tabGroups.query({ title: ompGroupTitle }).catch(() => []);
	for (const group of groups) {
		const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
		const ids = tabs.map(tab => tab.id).filter(id => id !== undefined);
		if (ids.length > 0) await chrome.tabs.ungroup(ids).catch(() => {});
	}
}

function post(msg: ExtToRelayMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function setBadge(connected: boolean): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: connected ? "on" : "off" });
		await chrome.action.setBadgeBackgroundColor({ color: connected ? "#1a7f37" : "#8b8b8b" });
	} catch {

	}
}

async function buildHello(): Promise<ExtToRelayMessage> {
	const [tabs, targets] = await Promise.all([chrome.tabs.query({}), chrome.debugger.getTargets()]);
	const snapshots: TabSnapshot[] = [];
	for (const tab of tabs) {
		const snap = snapshot(tab);
		if (snap) snapshots.push(snap);
	}
	const attachedTabIds = await ownedDebuggerTabs(targets, tabId => chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"));
	const versionMatch = /Chrome\/[\d.]+/.exec(navigator.userAgent);
	return {
		t: "hello",
		browserSession: await ensureBrowserSession(),
		userAgent: navigator.userAgent,
		browserVersion: versionMatch?.[0] ?? "Chrome/unknown",
		discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
		protoVersion: typeof PROTO_INSTALL_VERSION === "string" ? PROTO_INSTALL_VERSION : undefined,
		reloadProtocol: EXTENSION_RELOAD_PROTOCOL_VERSION,
		tabs: snapshots,
		attachedTabIds,
	};
}

async function runRpc(msg: Extract<RelayToExtMessage, { t: "rpc" }>, origin: WebSocket): Promise<unknown> {
	switch (msg.op) {
		case "attach":
			await chrome.debugger.attach({ tabId: msg.tabId }, "1.3");
			return {};
		case "detach":
			relayDetaches.add(msg.tabId);
			try {
				await chrome.debugger.detach({ tabId: msg.tabId });
			} finally {
				relayDetaches.delete(msg.tabId);
			}
			return {};
		case "send":
			return await chrome.debugger.sendCommand(
				msg.sessionId ? { tabId: msg.tabId, sessionId: msg.sessionId } : { tabId: msg.tabId },
				msg.method,
				msg.params,
			);
		case "createTab": {
			const tab = await chrome.tabs.create({ url: msg.url, active: msg.active ?? true });
			const snap = snapshot(tab);
			if (!snap) throw new Error("created tab has no id");
			if (origin !== ws || origin.readyState !== WebSocket.OPEN) void removeTab(snap.tabId).catch(() => {});
			return { tab: snap };
		}
		case "removeTab":
			await removeTab(msg.tabId);
			return {};
		case "activateTab": {
			const tab = await chrome.tabs.get(msg.tabId);
			await chrome.windows.update(tab.windowId, { focused: true });
			await chrome.tabs.update(msg.tabId, { active: true });
			return {};
		}
		case "group":
			return await enqueueGroupOp(() => groupTabs(msg.tabIds, msg.title, msg.color));
		case "ungroup":
			await enqueueGroupOp(() => chrome.tabs.ungroup(msg.tabIds).catch(() => {}));
			return {};
	}
}

async function removeTab(tabId: number): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await chrome.tabs.remove(tabId);
			return;
		} catch (error) {
			if (/No tab with id/.test(String(error))) return;
			if (attempt >= 3) throw error;
			const pause = Promise.withResolvers<void>();
			setTimeout(pause.resolve, 500);
			await pause.promise;
		}
	}
}

function handleRelayMessage(socket: WebSocket, raw: string): void {
	let msg: RelayToExtMessage;
	try {
		msg = JSON.parse(raw) as RelayToExtMessage;
	} catch {
		return;
	}
	if (socket !== ws) return;
	if (msg.t === "pong") return;
	if (msg.t === "reload") {
		chrome.runtime.reload();
		return;
	}
	const answer = (reply: ExtToRelayMessage): void => {
		if (socket === ws && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
	};
	void runRpc(msg, socket)
		.then(result => answer({ t: "rpcResult", id: msg.id, ok: true, result }))
		.catch((err: unknown) => answer({ t: "rpcResult", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }));
}

function scheduleReconnect(): void {
	const delay = reconnectDelay;
	reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
	setTimeout(() => void connect(), delay);
}

async function connect(): Promise<void> {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	const settings = await loadSettings();
	const url = `ws://127.0.0.1:${settings.port}/ext${settings.token ? `?token=${encodeURIComponent(settings.token)}` : ""}`;
	const socket = new WebSocket(url);
	ws = socket;
	socket.onopen = () => {
		reconnectDelay = RECONNECT_MIN_MS;
		void setBadge(true);
		void buildHello().then(hello => {
			if (ws === socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(hello));
		}).catch(() => socket.close());
		clearInterval(pingTimer ?? undefined);
		pingTimer = setInterval(() => post({ t: "ping" }), PING_INTERVAL_MS);
	};
	socket.onmessage = event => {
		if (typeof event.data === "string") handleRelayMessage(socket, event.data);
	};
	socket.onclose = () => {
		if (ws !== socket) return;
		ws = null;
		if (pingTimer !== null) {
			clearInterval(pingTimer);
			pingTimer = null;
		}
		void setBadge(false);
		void restoreGroups();
		scheduleReconnect();
	};
	socket.onerror = () => {
		socket.close();
	};
}



chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.tabId === undefined) return;
	post({ t: "cdpEvent", tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId === undefined) return;
	post({ t: "detached", tabId: source.tabId, reason, relayInitiated: relayDetaches.delete(source.tabId) || undefined });
});

chrome.tabs.onCreated.addListener(tab => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabCreated", tab: snap });
});

chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
	const snap = snapshot(tab);
	if (snap) post({ t: "tabUpdated", tab: snap });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
	void chrome.tabs.get(tabId).then(tab => {
		const snap = snapshot(tab);
		if (snap) post({ t: "tabUpdated", tab: snap });
	}).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
	post({ t: "tabRemoved", tabId });
});



chrome.alarms.create("proto-relay-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
	if (alarm.name === "proto-relay-keepalive") void connect();
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
	if (areaName !== "local") return;

	ws?.close();
	void connect();
});

chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());

void connect();
