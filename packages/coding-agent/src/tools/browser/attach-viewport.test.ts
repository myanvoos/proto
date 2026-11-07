import { afterAll, beforeAll, expect, test } from "bun:test";
import * as os from "node:os";
import type { Browser, Page } from "puppeteer-core";
import type { ToolSession } from "../index";
import { ensureChromiumExecutable, launchHeadlessBrowser, removeUserDataDir } from "./launch";
import { acquireBrowser } from "./registry";
import { acquireTab, releaseTab, runInTab } from "./tab-supervisor";

const chromium = await ensureChromiumExecutable();
const browserTest = chromium ? test : test.skip;
// A window whose own device scale is 2, as a HiDPI screen reports it.
const WINDOW_SCALE = 2;
const session = { cwd: os.tmpdir(), settings: { get: () => undefined } } as unknown as ToolSession;

let browser: Browser;
let wsEndpoint: string;
let profile: string | undefined;
const pages: Page[] = [];
const names: string[] = [];

beforeAll(async () => {
	if (!chromium) return;
	const launched = await launchHeadlessBrowser({
		headless: true,
		args: [`--force-device-scale-factor=${WINDOW_SCALE}`],
	});
	browser = launched.browser;
	wsEndpoint = launched.wsEndpoint;
	profile = launched.userDataDir;
});

afterAll(async () => {
	await Promise.all(names.splice(0).map(name => releaseTab(name).catch(() => undefined)));
	await Promise.all(pages.splice(0).map(page => page.close().catch(() => undefined)));
	await browser?.close();
	if (profile) await removeUserDataDir(profile);
});

function pageSize(name: string): Promise<{ width: number; height: number; deviceScaleFactor: number }> {
	return runInTab(name, {
		code: "return await tab.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }));",
		timeoutMs: 5_000,
		session,
	}).then(result => result.returnValue as { width: number; height: number; deviceScaleFactor: number });
}

browserTest(
	"an open viewport sizes an attached page and keeps the window's own device scale without one",
	async () => {
		const title = `attached-viewport-${crypto.randomUUID()}`;
		const page = await browser.newPage();
		pages.push(page);
		await page.setViewport({ width: 1_000, height: 700, deviceScaleFactor: WINDOW_SCALE });
		await page.setContent(`<title>${title}</title>`);

		const name = `attached-viewport-${crypto.randomUUID()}`;
		names.push(name);
		const endpoint = new URL(wsEndpoint);
		const handle = await acquireBrowser(
			{ kind: "connected", cdpUrl: `http://${endpoint.host}` },
			{ cwd: os.tmpdir() },
		);

		// The first open adopts the page, so before this reached the worker the window kept its own size.
		await acquireTab(name, handle, { target: title, viewport: { width: 390, height: 844 }, timeoutMs: 10_000 });
		expect(await pageSize(name)).toEqual({ width: 390, height: 844, deviceScaleFactor: WINDOW_SCALE });

		// Reopening the live tab applies the new viewport the same way.
		await acquireTab(name, handle, { target: title, viewport: { width: 400, height: 800 }, timeoutMs: 10_000 });
		expect(await pageSize(name)).toEqual({ width: 400, height: 800, deviceScaleFactor: WINDOW_SCALE });
	},
	30_000,
);
