import { afterEach, describe, expect, it, jest } from "bun:test";
import { RelayBridge, type RelaySocket } from "./bridge";
import type { RelayRpcRequest, RelayToExtMessage, TabSnapshot } from "./protocol";

type Rpc<Op extends RelayRpcRequest["op"]> = { t: "rpc"; id: number } & Extract<RelayRpcRequest, { op: Op }>;
interface CdpMessage {
	id?: number;
	sessionId?: string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message: string };
}
class Extension implements RelaySocket {
	messages: RelayToExtMessage[] = [];
	acked = new Set<number>();
	closed = false;
	send(text: string): void {
		this.messages.push(JSON.parse(text) as RelayToExtMessage);
	}
	close(): void {
		this.closed = true;
	}
	pending<Op extends RelayRpcRequest["op"]>(op: Op): Rpc<Op>[] {
		return this.messages.filter((m): m is Rpc<Op> => m.t === "rpc" && m.op === op && !this.acked.has(m.id));
	}
}
class Client implements RelaySocket {
	messages: CdpMessage[] = [];
	send(text: string): void {
		this.messages.push(JSON.parse(text) as CdpMessage);
	}
	close(): void {}
}
function tab(tabId = 1, overrides: Partial<TabSnapshot> = {}): TabSnapshot {
	return {
		tabId,
		url: "https://example.com/",
		title: "Example",
		active: false,
		discarded: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...overrides,
	};
}
async function flush(): Promise<void> {
	for (let i = 0; i < 24; i++) await Promise.resolve();
}
const bridges: Array<{ bridge: RelayBridge; ext: Extension }> = [];
function setup(tabs: TabSnapshot[] = [tab()], options: ConstructorParameters<typeof RelayBridge>[0] = {}) {
	const bridge = new RelayBridge(options);
	const ext = new Extension();
	bridge.extConnected(ext);
	bridge.extMessage(
		ext,
		JSON.stringify({
			t: "hello",
			userAgent: "test",
			browserVersion: "Chrome/151",
			discardedTabsProtocol: 1,
			tabs,
			attachedTabIds: [],
		}),
	);
	bridges.push({ bridge, ext });
	const client = new Client();
	const id = bridge.cdpConnected(client);
	return { bridge, ext, client, id };
}
function answer(
	bridge: RelayBridge,
	ext: Extension,
	op: RelayRpcRequest["op"],
	result: unknown = {},
	error?: string,
): void {
	for (const request of ext.pending(op)) {
		ext.acked.add(request.id);
		bridge.extMessage(
			ext,
			JSON.stringify({ t: "rpcResult", id: request.id, ok: error === undefined, result, error }),
		);
	}
}
function command(
	bridge: RelayBridge,
	id: number,
	method: string,
	params?: Record<string, unknown>,
	sessionId?: string,
): number {
	const call = ++sequence;
	bridge.cdpMessage(id, JSON.stringify({ id: call, method, params, sessionId }));
	return call;
}
let sequence = 0;
async function attach(bridge: RelayBridge, ext: Extension, client: Client, id: number): Promise<string> {
	const call = command(bridge, id, "Target.attachToTarget", { targetId: "PAGE1" });
	answer(bridge, ext, "attach");
	await flush();
	const session = client.messages.find(m => m.id === call)?.result?.sessionId;
	if (typeof session !== "string") throw new Error("Page attachment failed");
	return session;
}
function event(
	bridge: RelayBridge,
	ext: Extension,
	method: string,
	params: Record<string, unknown>,
	sessionId?: string,
): void {
	bridge.extMessage(ext, JSON.stringify({ t: "cdpEvent", tabId: 1, method, params, sessionId }));
}
afterEach(async () => {
	for (const { bridge, ext } of bridges.splice(0)) bridge.extClosed(ext);
	await flush();
	jest.useRealTimers();
});

describe("relay target lifetime", () => {
	it("does not wait for discarded tabs and attaches them once Chrome revives them", async () => {
		const { bridge, ext, client, id } = setup([tab(1, { discarded: true }), tab(2)]);
		command(bridge, id, "Target.setDiscoverTargets", { discover: true });
		const auto = command(bridge, id, "Target.setAutoAttach", { autoAttach: true });
		expect(ext.pending("attach").map(m => m.tabId)).toEqual([2]);
		answer(bridge, ext, "attach");
		await flush();
		expect(client.messages.find(m => m.id === auto)?.result).toEqual({});
		expect(client.messages.some(m => m.method === "Target.targetDestroyed" && m.params?.targetId === "PAGE1")).toBe(
			true,
		);
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab(1) }));
		expect(ext.pending("attach").map(m => m.tabId)).toEqual([1]);
		answer(bridge, ext, "attach");
		await flush();
		expect(
			client.messages.some(
				m =>
					m.method === "Target.attachedToTarget" &&
					(m.params?.targetInfo as { targetId?: string } | undefined)?.targetId === "TAB1",
			),
		).toBe(true);
	});

	it("releases a connect waiting on a tab discarded mid-attach and cleans its late attachment", async () => {
		const { bridge, ext, client, id } = setup();
		command(bridge, id, "Target.setDiscoverTargets", { discover: true });
		const auto = command(bridge, id, "Target.setAutoAttach", { autoAttach: true });
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab(1, { discarded: true }) }));
		await flush();
		expect(client.messages.find(m => m.id === auto)?.result).toEqual({});
		answer(bridge, ext, "attach");
		await flush();
		expect(ext.pending("detach").map(m => m.tabId)).toEqual([1]);
	});

	it("forwards Chrome's attach refusal on a created tab and closes it instead of leaving the open hanging", async () => {
		const { bridge, ext, client, id } = setup([]);
		command(bridge, id, "Target.setAutoAttach", { autoAttach: true });
		const call = command(bridge, id, "Target.createTarget", { background: true });
		expect(ext.pending("createTab")[0]?.active).toBe(false);
		answer(bridge, ext, "createTab", { tab: tab() });
		await flush();
		answer(bridge, ext, "attach", {}, "Blocked by enterprise policy");
		await flush();
		expect(ext.pending("removeTab")[0]?.tabId).toBe(1);
		answer(bridge, ext, "removeTab");
		await flush();
		expect(client.messages.find(m => m.id === call)?.error?.message).toContain("Blocked by enterprise policy");
	});

	it("closes a created tab when its requesting client left before Chrome answered", async () => {
		const { bridge, ext, id } = setup([]);
		command(bridge, id, "Target.createTarget", { url: "https://example.com" });
		bridge.cdpClosed(id);
		answer(bridge, ext, "createTab", { tab: tab() });
		await flush();
		expect(ext.pending("removeTab")[0]?.tabId).toBe(1);
	});

	it("routes page-session target operations through relay ids and rejects an unknown activation", async () => {
		const { bridge, ext, client, id } = setup();
		const page = await attach(bridge, ext, client, id);
		command(bridge, id, "Target.createTarget", { background: true, newWindow: true }, page);
		expect(ext.pending("createTab")[0]?.active).toBe(false);
		expect(ext.pending("send")).toHaveLength(0);
		const activation = command(bridge, id, "Target.activateTarget", { targetId: "unknown" }, page);
		await flush();
		expect(client.messages.find(m => m.id === activation)?.error?.message).toContain("No target");
	});

	it("updates the active tab only in its own window", () => {
		const { bridge, ext } = setup([tab(1, { active: true }), tab(2, { active: true, windowId: 2 }), tab(3)]);
		bridge.extMessage(ext, JSON.stringify({ t: "tabUpdated", tab: tab(3, { active: true }) }));
		expect(
			bridge
				.listTargets()
				.filter(t => t.active === "true")
				.map(t => t.id),
		).toEqual(["PAGE2", "PAGE3"]);
	});
});

describe("relay child target ownership", () => {
	it("announces a child once to its armed parent and keeps its detach on that parent", async () => {
		const { bridge, ext, client, id } = setup();
		const first = await attach(bridge, ext, client, id);
		const second = await attach(bridge, ext, client, id);
		command(bridge, id, "Target.setAutoAttach", { autoAttach: true }, first);
		command(bridge, id, "Target.setAutoAttach", { autoAttach: true }, second);
		answer(bridge, ext, "send");
		await flush();
		event(bridge, ext, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" } });
		const announced = client.messages.filter(
			m => m.method === "Target.attachedToTarget" && m.params?.sessionId === "child",
		);
		expect(announced.map(m => m.sessionId)).toEqual([first]);
		command(bridge, id, "Target.detachFromTarget", { sessionId: first });
		event(bridge, ext, "Page.frameNavigated", { frame: { id: "frame" } }, "child");
		event(bridge, ext, "Target.detachedFromTarget", { sessionId: "child" });
		expect(
			client.messages
				.filter(m => m.method === "Target.detachedFromTarget" && m.params?.sessionId === "child")
				.map(m => m.sessionId),
		).toEqual([first]);
		expect(client.messages.filter(m => m.method === "Page.frameNavigated" && m.sessionId === "child")).toHaveLength(
			1,
		);
	});

	it("replays pre-existing iframe children to a late connection before its auto-attach reply", async () => {
		const { bridge, ext, client, id } = setup();
		const first = await attach(bridge, ext, client, id);
		command(bridge, id, "Target.setAutoAttach", { autoAttach: true }, first);
		answer(bridge, ext, "send");
		await flush();
		event(bridge, ext, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" } });
		const later = new Client();
		const laterId = bridge.cdpConnected(later);
		const page = await attach(bridge, ext, later, laterId);
		const auto = command(bridge, laterId, "Target.setAutoAttach", { autoAttach: true }, page);
		answer(bridge, ext, "send");
		await flush();
		const child = later.messages.findIndex(
			m => m.method === "Target.attachedToTarget" && m.params?.sessionId === "child",
		);
		expect(child).toBeGreaterThanOrEqual(0);
		expect(child).toBeLessThan(later.messages.findIndex(m => m.id === auto));
	});

	it("does not leak children to a page session whose auto-attach failed", async () => {
		const { bridge, ext, client, id } = setup();
		const page = await attach(bridge, ext, client, id);
		command(bridge, id, "Target.setAutoAttach", { autoAttach: true }, page);
		answer(bridge, ext, "send", {}, "not permitted");
		await flush();
		event(bridge, ext, "Target.attachedToTarget", { sessionId: "child" });
		expect(client.messages.some(m => m.params?.sessionId === "child")).toBe(false);
	});
});

describe("relay shared file chooser interception", () => {
	it("keeps interception on for the remaining owner and disables it when that owner disconnects", async () => {
		const { bridge, ext, client, id } = setup();
		const first = await attach(bridge, ext, client, id);
		const other = new Client();
		const otherId = bridge.cdpConnected(other);
		const second = await attach(bridge, ext, other, otherId);
		for (const [owner, page] of [
			[id, first],
			[otherId, second],
		] as const) {
			command(bridge, owner, "Page.setInterceptFileChooserDialog", { enabled: true }, page);
			answer(bridge, ext, "send");
			await flush();
		}
		command(bridge, id, "Page.setInterceptFileChooserDialog", { enabled: false }, first);
		expect(ext.pending("send")[0]?.params?.enabled).toBe(true);
		answer(bridge, ext, "send");
		await flush();
		bridge.cdpClosed(otherId);
		await flush();
		expect(ext.pending("send")[0]?.params?.enabled).toBe(false);
	});

	it("serializes overlapping changes so an earlier failure cannot undo a later enable", async () => {
		const { bridge, ext, client, id } = setup();
		const page = await attach(bridge, ext, client, id);
		command(bridge, id, "Page.setInterceptFileChooserDialog", { enabled: true }, page);
		command(bridge, id, "Page.setInterceptFileChooserDialog", { enabled: true }, page);
		expect(ext.pending("send")).toHaveLength(1);
		answer(bridge, ext, "send", {}, "failed first transition");
		await flush();
		expect(ext.pending("send")[0]?.params?.enabled).toBe(true);
		answer(bridge, ext, "send");
		await flush();
		command(bridge, id, "Target.detachFromTarget", { sessionId: page });
		await flush();
		expect(ext.pending("send")[0]?.params?.enabled).toBe(false);
	});
});

describe("relay deadlines and idle updates", () => {
	it("keeps page-bound commands running past 20 s but reports a typed ordinary command timeout", async () => {
		jest.useFakeTimers();
		const { bridge, ext, client, id } = setup();
		const page = await attach(bridge, ext, client, id);
		const wait = command(bridge, id, "Runtime.evaluate", { awaitPromise: true }, page);
		const quick = command(bridge, id, "Page.getFrameTree", {}, page);
		jest.advanceTimersByTime(20_001);
		await flush();
		expect(client.messages.find(m => m.id === wait)).toBeUndefined();
		expect(client.messages.find(m => m.id === quick)?.error?.message).toContain("Page.getFrameTree on tab 1");
		answer(bridge, ext, "send", { result: { value: "settled" } });
		await flush();
		expect(client.messages.find(m => m.id === wait)?.result?.result).toEqual({ value: "settled" });
	});

	it("closes a late tab creation only within its bounded cleanup window", async () => {
		jest.useFakeTimers();
		const { bridge, ext, client, id } = setup([]);
		const create = command(bridge, id, "Target.createTarget", {});
		jest.advanceTimersByTime(20_001);
		await flush();
		expect(client.messages.find(m => m.id === create)?.error?.message).toContain("timed out");
		answer(bridge, ext, "createTab", { tab: tab() });
		await flush();
		expect(ext.pending("removeTab")[0]?.tabId).toBe(1);
		answer(bridge, ext, "removeTab");
		await flush();
		command(bridge, id, "Target.createTarget", {});
		jest.advanceTimersByTime(80_001);
		await flush();
		answer(bridge, ext, "createTab", { tab: tab(2) });
		await flush();
		expect(ext.pending("removeTab")).toHaveLength(0);
	});

	it("releases an attach abandoned by its last client before reloading an older idle extension", async () => {
		let writes = 0;
		const { bridge, ext, client, id } = setup([tab()], {
			updateExtension: async () => {
				writes++;
				return true;
			},
		});
		bridge.extConnected(ext, "a".repeat(32));
		bridge.extMessage(
			ext,
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151",
				discardedTabsProtocol: 1,
				reloadProtocol: 1,
				protoVersion: "0.0.0",
				tabs: [tab()],
				attachedTabIds: [],
			}),
		);
		command(bridge, id, "Target.attachToTarget", { targetId: "PAGE1" });
		bridge.cdpClosed(id);
		answer(bridge, ext, "attach");
		await flush();
		expect(writes).toBe(0);
		expect(ext.pending("detach")).toHaveLength(1);
		answer(bridge, ext, "detach");
		await flush();
		expect(writes).toBe(1);
		expect(ext.messages.some(m => m.t === "reload")).toBe(true);
		expect(bridge.ready).toBe(false);
		expect(client.messages.some(m => m.error)).toBe(false);
	});
});
