import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, ElementHandle, Page } from "puppeteer-core";
import { ensureChromiumExecutable, launchHeadlessBrowser, removeUserDataDir } from "./launch";
import type { ObservationEntry } from "./tab-protocol";
import { collectObservationEntries, type WorkerCore, waitForActionableHandle } from "./tab-worker";

const chromium = await ensureChromiumExecutable();
const browserTest = chromium ? test : test.skip;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>idle</title></head>
<body style="margin:0;padding:40px">
<p>filler copy above the control</p>
<button id="go" style="display:inline-block">Go</button>
<script>
document.getElementById("go").addEventListener("click", () => {
	document.title = "clicked";
});
</script>
</body></html>`;

const STALL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>stall</title></head>
<body style="margin:0;padding:40px">
<button id="go" style="display:inline-block">Go</button>
</body></html>`;

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let userDataDir: string | undefined;
/** Swaps the viewport probe used by the code under test; the page and handles stay real. */
let probeOverride: (() => Promise<boolean>) | null = null;
let restoreProbe: (() => void) | undefined;

function installProbeSwitch(handle: ElementHandle): void {
	const key = "isIntersectingViewport";
	let proto = Object.getPrototypeOf(handle) as object | null;
	while (proto && !Object.getOwnPropertyDescriptor(proto, key)) proto = Object.getPrototypeOf(proto) as object | null;
	if (!proto) throw new Error("puppeteer ElementHandle lost isIntersectingViewport");
	const original = Object.getOwnPropertyDescriptor(proto, key);
	if (!original) throw new Error("puppeteer ElementHandle lost isIntersectingViewport");
	const originalFn = original.value as (this: unknown, ...args: unknown[]) => Promise<boolean>;
	Object.defineProperty(proto, key, {
		configurable: true,
		writable: true,
		value: function (this: unknown, ...args: unknown[]): Promise<boolean> {
			return probeOverride ? probeOverride() : originalFn.apply(this, args);
		},
	});
	restoreProbe = () => Object.defineProperty(proto, key, original);
}

/** Fails loudly instead of hanging when the code under test ignores its abort signal. */
function guard<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
	const bail = Promise.withResolvers<never>();
	const timer = setTimeout(() => bail.reject(new Error(`${label} never settled within ${ms}ms`)), ms);
	return Promise.race([work, bail.promise]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Waits for the evidence that matters — a trivial evaluate no longer answering — instead of
 * guessing how long the injected busy loop needs to take over the renderer thread.
 */
async function waitUntilRendererBlocked(page: Page): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const alive = Promise.withResolvers<"blocked">();
		const timer = setTimeout(() => alive.resolve("blocked"), 200);
		const state = await Promise.race([
			page
				.evaluate(() => true)
				.then(() => "alive" as const)
				.catch(() => "alive" as const),
			alive.promise,
		]);
		clearTimeout(timer);
		if (state === "blocked") return;
	}
	throw new Error("renderer never stalled");
}

async function openFixture(path: string): Promise<Page> {
	if (!browser || !server) throw new Error("fixture browser unavailable");
	const page = await browser.newPage();
	await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "load" });
	return page;
}

beforeAll(async () => {
	if (!chromium) return;
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			const body = pathname === "/stall" ? STALL_HTML : PAGE_HTML;
			return new Response(body, { headers: { "content-type": "text/html" } });
		},
	});
	const launched = await launchHeadlessBrowser({ headless: true });
	browser = launched.browser;
	userDataDir = launched.userDataDir;
});

afterAll(async () => {
	restoreProbe?.();
	const child = browser?.process();
	// A deliberately blocked renderer answers a graceful close only once its busy loop ends, so
	// allow for that before falling back to a hard kill; otherwise the browser would be leaked.
	const forced = Promise.withResolvers<void>();
	const timer = setTimeout(() => forced.resolve(), 12_000);
	await Promise.race([browser?.close().catch(() => undefined) ?? Promise.resolve(), forced.promise]);
	clearTimeout(timer);
	if (child?.exitCode === null) child.kill("SIGKILL");
	server?.stop(true);
	if (userDataDir) await removeUserDataDir(userDataDir).catch(() => undefined);
});

browserTest(
	"a click target whose viewport probe reports nothing still resolves to the actionable element",
	async () => {
		const page = await openFixture("/");
		try {
			installProbeSwitch((await page.$("#go")) as ElementHandle);
			probeOverride = async () => false;
			const handle = await guard(
				waitForActionableHandle(page, "#go", 4_000, AbortSignal.timeout(4_000), "clicking", true),
				15_000,
				"waitForActionableHandle",
			);
			await handle.click();
			expect(await page.title()).toBe("clicked");
		} finally {
			probeOverride = null;
			await page.close().catch(() => undefined);
		}
	},
	30_000,
);

browserTest(
	"a viewport probe that never settles fails at the actionability deadline",
	async () => {
		const page = await openFixture("/");
		const never = Promise.withResolvers<boolean>();
		try {
			installProbeSwitch((await page.$("#go")) as ElementHandle);
			probeOverride = () => never.promise;
			const started = Date.now();
			await expect(
				guard(
					waitForActionableHandle(page, "#go", 700, AbortSignal.timeout(700), "clicking", true),
					15_000,
					"waitForActionableHandle",
				),
			).rejects.toThrow(/Timed out clicking "#go" after 700ms/);
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			probeOverride = null;
			never.resolve(true);
			await page.close().catch(() => undefined);
		}
	},
	30_000,
);

browserTest(
	"a stalled renderer fails at the actionability deadline instead of hanging",
	async () => {
		const page = await openFixture("/stall");
		const handles = (await page.$$("#go")) as ElementHandle[];
		// Matches are resolved before the stall so the wait starts at the element probes, which is
		// where a blocked renderer used to keep the run alive past every timeout.
		const stalledPage = new Proxy(page, {
			get: (target, key, receiver) => (key === "$$" ? async () => handles : Reflect.get(target, key, receiver)),
		}) as Page;
		void page
			.evaluate(() => {
				const end = Date.now() + 6_000;
				while (Date.now() < end) {
					// Deliberately block the renderer's main thread.
				}
			})
			.catch(() => undefined);
		await waitUntilRendererBlocked(page);
		const started = Date.now();
		await expect(
			guard(
				waitForActionableHandle(stalledPage, "#go", 800, AbortSignal.timeout(800), "clicking", true),
				15_000,
				"waitForActionableHandle",
			),
		).rejects.toThrow(/Timed out clicking "#go" after 800ms/);
		expect(Date.now() - started).toBeLessThan(5_000);
	},
	30_000,
);

function observationCore(): WorkerCore {
	let next = 0;
	const core = {
		nextElementId: () => ++next,
		cacheElement: () => undefined,
	};
	return core as unknown as WorkerCore;
}

browserTest(
	"observation keeps an element whose viewport probe fails and says the probe failed",
	async () => {
		const page = await openFixture("/");
		try {
			installProbeSwitch((await page.$("#go")) as ElementHandle);
			probeOverride = async () => {
				throw new Error("probe exploded");
			};
			const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
			expect(snapshot).not.toBeNull();
			const entries: ObservationEntry[] = [];
			await guard(
				collectObservationEntries(observationCore(), snapshot!, entries, {
					includeAll: false,
					viewportOnly: true,
					signal: AbortSignal.timeout(5_000),
				}),
				15_000,
				"collectObservationEntries",
			);
			const button = entries.find(entry => entry.role === "button");
			expect(button).toBeDefined();
			expect(button?.states).toContain("viewport-unknown");
		} finally {
			probeOverride = null;
			await page.close().catch(() => undefined);
		}
	},
	30_000,
);

browserTest(
	"observation aborts when the viewport probe never settles",
	async () => {
		const page = await openFixture("/");
		const never = Promise.withResolvers<boolean>();
		try {
			installProbeSwitch((await page.$("#go")) as ElementHandle);
			probeOverride = () => never.promise;
			const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
			const started = Date.now();
			await expect(
				guard(
					collectObservationEntries(observationCore(), snapshot!, [], {
						includeAll: false,
						viewportOnly: true,
						signal: AbortSignal.timeout(600),
					}),
					15_000,
					"collectObservationEntries",
				),
			).rejects.toThrow(/aborted/i);
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			probeOverride = null;
			never.resolve(true);
			await page.close().catch(() => undefined);
		}
	},
	30_000,
);
