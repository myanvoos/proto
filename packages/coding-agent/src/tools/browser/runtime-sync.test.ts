import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import type { Browser, ConsoleMessage, Page } from "puppeteer-core";
import type { ToolSession } from "../index";
import { ensureChromiumExecutable, launchHeadlessBrowser, loadPuppeteer, removeUserDataDir } from "./launch";
import { acquireBrowser } from "./registry";
import type { WorkerInbound, WorkerOutbound } from "./tab-protocol";
import { acquireTab, getTab, releaseTab, runInTab } from "./tab-supervisor";
import {
	clickElement,
	createRunPageScope,
	fillViaHandle,
	navigateMainFrame,
	pressKey,
	selectElementOptions,
	untilAbortedOrReleased,
	uploadFileContents,
	WorkerCore,
	whileDrawing,
} from "./tab-worker";

interface FileInputElement extends Element {
	files: ArrayLike<{ name: string; text(): Promise<string> }> | null;
}

const chromium = await ensureChromiumExecutable();
const browserTest = chromium ? test : test.skip;
let browser: Browser;
let wsEndpoint: string;
let profile: string | undefined;
const pages: Page[] = [];
const names: string[] = [];
const dirs: string[] = [];
const session = { cwd: os.tmpdir(), settings: { get: () => undefined } } as unknown as ToolSession;

beforeAll(async () => {
	if (!chromium) return;
	const launched = await launchHeadlessBrowser({ headless: true });
	browser = launched.browser;
	wsEndpoint = launched.wsEndpoint;
	profile = launched.userDataDir;
});
afterEach(async () => {
	await Promise.all(names.splice(0).map(name => releaseTab(name).catch(() => undefined)));
	await Promise.all(pages.splice(0).map(page => page.close().catch(() => undefined)));
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
afterAll(async () => {
	await browser?.close();
	if (profile) await removeUserDataDir(profile);
});
async function pageWith(html: string): Promise<Page> {
	const page = await browser.newPage();
	pages.push(page);
	await page.setContent(html);
	return page;
}
async function connectedTab(target: string): Promise<string> {
	const name = `runtime-sync-${crypto.randomUUID()}`;
	names.push(name);
	const endpoint = new URL(wsEndpoint);
	const handle = await acquireBrowser({ kind: "connected", cdpUrl: `http://${endpoint.host}` }, { cwd: os.tmpdir() });
	await acquireTab(name, handle, { target, timeoutMs: 10_000 });
	return name;
}

browserTest(
	"picker and rich-text fills replace contents and refuse invalid values without editing the field",
	async () => {
		const page = await pageWith(
			'<input id="date" type="date"><input id="range" type="range" value="40"><div id="editor" contenteditable>old <b>bold</b></div>',
		);
		const date = (await page.$("#date"))!;
		await fillViaHandle(date, "2026-10-12");
		expect(await date.evaluate(el => el.value)).toBe("2026-10-12");
		const range = (await page.$("#range"))!;
		await expect(fillViaHandle(range, "not a number")).rejects.toThrow();
		expect(await range.evaluate(el => el.value)).toBe("40");
		const editor = (await page.$("#editor"))!;
		await fillViaHandle(editor, "replacement");
		expect(await editor.evaluate(el => el.textContent)).toBe("replacement");
		await fillViaHandle(editor, "");
		expect(await editor.evaluate(el => el.textContent)).toBe("");
	},
);

browserTest(
	"dropdown label fallback preserves value precedence and an unmatched request leaves selection untouched",
	async () => {
		const page = await pageWith(
			'<select><option value="first">second</option><option value="second">Label</option></select>',
		);
		const select = (await page.$("select"))!;
		expect(await selectElementOptions(select, ["second"], "test select")).toEqual(["second"]);
		expect(await selectElementOptions(select, ["Label"], "test select")).toEqual(["second"]);
		await expect(selectElementOptions(select, ["missing"], "test select")).rejects.toThrow("missing");
		expect(await select.evaluate(el => el.value)).toBe("second");
	},
);

browserTest("right and double clicks deliver the requested button and count without a left click", async () => {
	const page = await pageWith(
		'<button>Go</button><script>globalThis.events=[]; for(const type of ["click","contextmenu","dblclick"]) document.querySelector("button").addEventListener(type,e=>events.push([type,e.button,e.detail]));</script>',
	);
	const button = (await page.$("button"))!;
	await clickElement(button, "right click", AbortSignal.timeout(1000), { button: "right" });
	await clickElement(button, "double click", AbortSignal.timeout(1000), { clickCount: 2 });
	expect(await page.mainFrame().mainRealm().evaluate("events")).toEqual([
		["contextmenu", 2, 0],
		["click", 0, 1],
		["click", 0, 2],
		["dblclick", 0, 2],
	]);
});

browserTest("key combos select and replace text rather than typing the combo name", async () => {
	const page = await pageWith('<input value="old">');
	await page.focus("input");
	await pressKey(page, process.platform === "darwin" ? "MetaLeft+KeyA" : "Control+a");
	await page.keyboard.type("new");
	expect(await page.$eval("input", el => el.value)).toBe("new");
});

browserTest(
	"content upload transfers bytes, filename, and input/change events to a browser without host paths",
	async () => {
		const page = await pageWith(
			'<input type="file"><script>globalThis.events=[]; for(const type of ["input","change"]) document.querySelector("input").addEventListener(type,()=>events.push(type));</script>',
		);
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-upload-"));
		dirs.push(dir);
		const file = path.join(dir, "payload.txt");
		await Bun.write(file, "héllo uploaded bytes");
		await uploadFileContents((await page.$("input"))!, [file]);
		expect(
			await page.$eval("input", async el => {
				const file = (el as FileInputElement).files![0]!;
				return [file.name, await file.text()];
			}),
		).toEqual(["payload.txt", "héllo uploaded bytes"]);
		expect(await page.mainFrame().mainRealm().evaluate("events")).toEqual(["input", "change"]);
	},
);

browserTest("run-owned listeners are removed without removing existing or once-only browser listeners", async () => {
	const page = await pageWith("<title>listeners</title>");
	const events: string[] = [];
	page.on("console", () => events.push("existing"));
	const scope = createRunPageScope(page, async () => {});
	scope.page.on("console", () => events.push("run"));
	scope.page.once("console", () => events.push("once"));
	page.emit("console", {} as ConsoleMessage);
	page.emit("console", {} as ConsoleMessage);
	scope.detach();
	await scope.restoreInterception();
	page.emit("console", {} as ConsoleMessage);
	expect(events).toEqual(["existing", "run", "once", "existing", "run", "existing"]);
});

browserTest(
	"borrowed tabs remain open on release and observed iframe ids resolve only in their original document",
	async () => {
		const page = await pageWith(
			'<title>borrowed-observe</title><iframe srcdoc="<button>Child control</button>"></iframe>',
		);
		const name = await connectedTab("borrowed-observe");
		const observed = await runInTab(name, { code: "return await tab.observe();", timeoutMs: 5_000, session });
		const elements = (observed.returnValue as { elements: Array<{ id: number; name: string }> }).elements;
		const child = elements.find(el => el.name === "Child control");
		expect(child).toBeDefined();
		const resolved = await runInTab(name, {
			code: `return await (await tab.id(${child!.id})).evaluate(el => el.textContent);`,
			timeoutMs: 5_000,
			session,
		});
		expect(resolved.returnValue).toBe("Child control");
		await page.frames()[1]!.goto("data:text/html,<button>Replacement</button>");
		await expect(
			runInTab(name, { code: `return await tab.id(${child!.id});`, timeoutMs: 5_000, session }),
		).rejects.toThrow();
		await releaseTab(name);
		expect(page.isClosed()).toBe(false);
	},
);

browserTest("open navigation failures roll back a newly created tab instead of leaving its name busy", async () => {
	const name = `runtime-sync-${crypto.randomUUID()}`;
	names.push(name);
	const handle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: os.tmpdir() });
	await expect(
		acquireTab(name, handle, { url: "http://127.0.0.1:1/unreachable", timeoutMs: 5_000 }),
	).rejects.toThrow();
	expect(getTab(name)).toBeUndefined();
});

browserTest("a fresh attached-browser tab is created in the background and only the owned page closes", async () => {
	const original = await pageWith("<title>user page</title>");
	let receive: (message: WorkerInbound) => void = () => {};
	const ready = Promise.withResolvers<Extract<WorkerOutbound, { type: "ready" }>>();
	const closed = Promise.withResolvers<void>();
	const core = new WorkerCore(
		{
			send(message) {
				if (message.type === "ready") ready.resolve(message);
				if (message.type === "init-failed") ready.reject(new Error(message.error.message));
				if (message.type === "closed") closed.resolve();
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {},
		},
		false,
	);
	try {
		receive({
			type: "init",
			payload: {
				mode: "attach",
				page: { kind: "create" },
				browserWSEndpoint: wsEndpoint,
				safeDir: getPuppeteerDir(),
				timeoutMs: 5000,
			},
		});
		const result = await ready.promise;
		const created = browser
			.targets()
			.find(target => (target as unknown as { _targetId: string })._targetId === result.info.targetId);
		expect(created).toBeDefined();
		expect(await original.evaluate(() => document.visibilityState)).toBe("visible");
		receive({ type: "close" });
		await closed.promise;
		expect(
			browser
				.targets()
				.some(target => (target as unknown as { _targetId: string })._targetId === result.info.targetId),
		).toBe(false);
		expect(original.isClosed()).toBe(false);
	} finally {
		core.terminate();
	}
});

test("screenshot cancellation releases a DevTools session arriving after its deadline without capturing", async () => {
	const created = Promise.withResolvers<{ detach(): Promise<void> }>();
	let detached = false;
	let captures = 0;
	const controller = new AbortController();
	const screenshot = whileDrawing(
		{ createCDPSession: () => created.promise } as unknown as Page,
		controller.signal,
		async () => ++captures,
	);
	controller.abort(new Error("capture deadline"));
	await expect(screenshot).rejects.toThrow("Operation aborted");
	created.resolve({
		detach: async () => {
			detached = true;
		},
	});
	await Bun.sleep(0);
	expect(detached).toBe(true);
	expect(captures).toBe(0);
});

test("aborted resource waits dispose late handles rather than using them", async () => {
	const pending = Promise.withResolvers<{ dispose(): Promise<void> }>();
	const disposed = Promise.withResolvers<void>();
	const controller = new AbortController();
	const result = untilAbortedOrReleased(controller.signal, pending.promise, late => late.dispose());
	controller.abort(new Error("operation cancelled"));
	await expect(result).rejects.toThrow("operation cancelled");
	pending.resolve({ dispose: async () => disposed.resolve() });
	await disposed.promise;
});

test("main-frame navigation rejects a lifecycle event first observed after its deadline", async () => {
	await loadPuppeteer();
	const events = new Set<string>();
	const page = {
		isClosed: () => false,
		browser: () => ({ connected: true }),
		mainFrame: () => ({ detached: false, _lifecycleEvents: events }),
	} as unknown as Page;
	await expect(
		navigateMainFrame(page, "load", 5, undefined, async () => {
			await Bun.sleep(10);
			events.add("load");
		}),
	).rejects.toMatchObject({ name: "TimeoutError" });
});
