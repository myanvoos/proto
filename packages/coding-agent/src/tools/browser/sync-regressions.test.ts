import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, PuppeteerNode } from "puppeteer-core";
import type { DaemonBrokerClient } from "../../launch/client";
import type { DaemonSnapshot } from "../../launch/protocol";
import { BrowserTool } from "../browser";
import type { ToolSession } from "../index";
import { CmuxSocketClient } from "./cmux/socket-client";
import { connectPuppeteer, discardOwnedProfileSessions, seedOwnedProfilePreferences } from "./launch";
import { closeCdpTarget } from "./orphan-registry";
import { extractReadableFromHtml } from "./readable";
import { acquireBrowser, holdBrowser, releaseBrowser } from "./registry";
import { restartSharedBrowser, stopSharedBrowserIfUnreachable } from "./shared-daemon";
import { acquireTab, getTabsMapForTest, releaseTabsForOwner } from "./tab-supervisor";

const temporaryDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporaryDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function temporaryDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-browser-sync-"));
	temporaryDirs.push(dir);
	return dir;
}

test("readable text keeps block separation, pre indentation, empty table columns and nonbreaking spaces", async () => {
	const result = await extractReadableFromHtml(
		"<html><body><main><p>First paragraph.</p><p>Second paragraph.</p><pre>  indented\n\n    more</pre><table><tr><td></td><td>right</td></tr><tr><td>left</td><td>end</td></tr></table><div>A&nbsp; B</div></main></body></html>",
		"https://example.com",
		"text",
	);
	expect(result?.text).toContain("First paragraph.\n\nSecond paragraph.");
	expect(result?.text).toContain("  indented\n\n    more");
	expect(result?.text).toContain("\tright\nleft\tend");
	expect(result?.text).toContain("A\u00a0 B");
	expect(result?.contentLength).toBe(result?.text?.length);
});

test("owned profile preparation preserves preferences but removes stale session restore files", async () => {
	const dir = await temporaryDir();
	const preferences = path.join(dir, "Default", "Preferences");
	await Bun.write(preferences, JSON.stringify({ profile: { other: 7 }, untouched: true }));
	await Bun.write(path.join(dir, "Default", "Sessions", "Session_123"), "old page");
	await seedOwnedProfilePreferences(dir);
	await discardOwnedProfileSessions(dir);
	expect(await Bun.file(preferences).json()).toEqual({
		profile: { other: 7, password_manager_leak_detection: false },
		untouched: true,
	});
	expect(await Bun.file(path.join(dir, "Default", "Sessions", "Session_123")).exists()).toBe(false);
	await Bun.write(preferences, "broken-json");
	await seedOwnedProfilePreferences(dir);
	expect(await Bun.file(preferences).json()).toEqual({ profile: { password_manager_leak_detection: false } });
	expect(await fs.readdir(path.dirname(preferences))).toEqual(["Preferences"]);
});

test("an accepted CDP close remains unconfirmed while Chromium still lists the target", async () => {
	const handlers = new Set<(event: { targetId: string }) => void>();
	let gone = false;
	const session = {
		on: (_name: string, handler: (event: { targetId: string }) => void) => handlers.add(handler),
		off: (_name: string, handler: (event: { targetId: string }) => void) => handlers.delete(handler),
		send: async (method: string) => {
			if (method === "Target.getTargets") return { targetInfos: gone ? [] : [{ targetId: "target" }] };
			return { success: true };
		},
		detach: async () => undefined,
	};
	const browser = { target: () => ({ createCDPSession: async () => session }) } as unknown as Browser;
	expect(await closeCdpTarget(browser, "target", 5)).toBe(false);
	gone = true;
	expect(await closeCdpTarget(browser, "target", 5)).toBe(true);
	expect(handlers.size).toBe(0);
});

test("failed target cleanup stops only a twice-unreachable unchanged daemon with a confirmed terminal reply", async () => {
	const snapshot = {
		id: "one",
		name: "proto.browser.headless",
		state: "ready",
		startedAt: 1,
		readyMatch: "DevTools listening on ws://127.0.0.1:9222/devtools/browser/one",
	} as unknown as DaemonSnapshot;
	let stops = 0;
	let terminal = false;
	const client = {
		request: async (operation: { op: string }) => {
			if (operation.op === "stop") {
				stops++;
				return { op: "stop", daemon: { ...snapshot, state: terminal ? "exited" : "ready" } };
			}
			return { op: "describe", daemon: snapshot };
		},
	} as unknown as DaemonBrokerClient;
	const scope = { projectDir: "/tmp/proto-health-test", daemonName: "proto.browser.headless" };
	expect(await stopSharedBrowserIfUnreachable(scope, { client, probe: async () => true })).toBe(false);
	expect(stops).toBe(0);
	expect(await stopSharedBrowserIfUnreachable(scope, { client, probe: async () => false })).toBe(false);
	terminal = true;
	expect(await stopSharedBrowserIfUnreachable(scope, { client, probe: async () => false })).toBe(true);
	expect(stops).toBe(2);
});

test("an abandoned browser open cannot wedge its key or remove a replacement acquisition", async () => {
	const firstConnection = Promise.withResolvers<void>();
	let connects = 0;
	spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(() =>
		++connects === 1 ? firstConnection.promise : Promise.resolve(),
	);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => {});
	const kind = { kind: "cmux" as const, socketPath: `/tmp/proto-open-${crypto.randomUUID()}.sock` };
	const controller = new AbortController();
	const abandoned = acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal });
	const failure = abandoned.catch(error => error);
	controller.abort();
	const replacement = await acquireBrowser(kind, { cwd: "/tmp" });
	holdBrowser(replacement);
	firstConnection.resolve();
	expect((await failure).name).toBe("ToolAbortError");
	expect(await acquireBrowser(kind, { cwd: "/tmp" })).toBe(replacement);
	expect(connects).toBe(2);
	await releaseBrowser(replacement, { kill: false });
});

test("close all releases only this kernel owner's tabs, not another session with the same persisted id", async () => {
	spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => {});
	spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async (method: string) =>
		method === "browser.open_split" ? { surface_id: crypto.randomUUID(), url: "about:blank" } : {},
	);
	const names = [crypto.randomUUID(), crypto.randomUUID()];
	const owner = `owner-${crypto.randomUUID()}`;
	const other = `owner-${crypto.randomUUID()}`;
	for (const [index, ownerSessionId] of [owner, other].entries()) {
		const browser = await acquireBrowser({ kind: "cmux", socketPath: `/tmp/${names[index]}.sock` }, { cwd: "/tmp" });
		await acquireTab(names[index]!, browser, { timeoutMs: 1000, ownerSessionId });
	}
	try {
		const tool = new BrowserTool({
			cwd: "/tmp",
			settings: { get: () => undefined },
			getSessionId: () => "same-persisted-id",
			getEvalKernelOwnerId: () => owner,
		} as unknown as ToolSession);
		await tool.execute("close", { action: "close", all: true });
		expect(getTabsMapForTest().has(names[0]!)).toBe(false);
		expect(getTabsMapForTest().has(names[1]!)).toBe(true);
	} finally {
		await releaseTabsForOwner(owner);
		await releaseTabsForOwner(other);
	}
});

test("shared browser restart clears the broker's actual profile only after a confirmed stop", async () => {
	const dir = await temporaryDir();
	const sessions = path.join(dir, "Default", "Sessions", "Session_previous");
	await Bun.write(sessions, "old page");
	let terminal = false;
	let restarts = 0;
	const daemon = { id: "generation", name: "proto.browser.headless", state: "ready" };
	const client = {
		request: async (operation: { op: string; expectedId?: string }) => {
			if (operation.op === "describe") return { op: "describe", daemon, spec: { args: [`--user-data-dir=${dir}`] } };
			expect(operation.expectedId).toBe("generation");
			if (operation.op === "stop")
				return { op: "stop", daemon: { ...daemon, state: terminal ? "exited" : "ready" } };
			restarts++;
			expect(await Bun.file(sessions).exists()).toBe(false);
			return { op: "restart", daemon };
		},
	} as unknown as DaemonBrokerClient;
	await expect(restartSharedBrowser(client, daemon.name)).rejects.toThrow("still ready");
	expect(await Bun.file(sessions).exists()).toBe(true);
	expect(restarts).toBe(0);
	terminal = true;
	await restartSharedBrowser(client, daemon.name);
	expect(restarts).toBe(1);
});

test("CDP upgrade refusals retain the requested debugger endpoint even when transport throws an ErrorEvent shape", async () => {
	const endpoint = "ws://127.0.0.1:9222/devtools/browser/specific";
	const puppeteer = {
		connect: async () => {
			throw { message: "Unexpected server response: 503" };
		},
	} as unknown as PuppeteerNode;
	await expect(connectPuppeteer(puppeteer, { browserWSEndpoint: endpoint })).rejects.toThrow(endpoint);
	await expect(connectPuppeteer(puppeteer, { browserURL: "http://127.0.0.1:9222" })).rejects.toThrow("503");
});
