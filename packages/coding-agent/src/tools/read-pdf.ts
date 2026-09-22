import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import type { BrowserHandle } from "./browser/registry";
import type { ScreenshotResult } from "./browser/tab-protocol";
import { ToolAbortError, ToolError } from "./tool-errors";

const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
const PDF_PAGE_MEMBER_RE = /^(?:p|page[-_]?)(\d+)(?:[-_].*)?\.png$/i;
const PDF_RENDER_TIMEOUT_MS = 30_000;

const PDF_SCREENSHOT_CODE = `
let viewerFrame;
await wait(async () => {
	for (const frame of page.frames()) {
		try {
			const loaded = await frame.evaluate(() => {
				//!world=main
				const viewer = document.querySelector("pdf-viewer");
				if (viewer?.loadState_ === "success") return true;
				const toolbar = viewer?.shadowRoot?.querySelector("viewer-toolbar");
				const pageLength = toolbar
					?.shadowRoot?.querySelector("viewer-page-selector")
					?.shadowRoot?.querySelector("#pagelength")
					?.textContent;
				if (Number(pageLength) > 0 && !toolbar?.hasAttribute("loading_")) return true;

				return false;
			});
			if (loaded) {
				viewerFrame = frame;
				return true;
			}
		} catch {}
	}
	return false;
});
await page.screenshot({ type: "png" });
await viewerFrame.evaluate(() => {
	const { promise, resolve } = Promise.withResolvers();
	requestAnimationFrame(() =>
		requestAnimationFrame(() =>
			requestAnimationFrame(() => requestAnimationFrame(resolve)),
		),
	);
	return promise;
});
// The PDF viewer scrolls internally; full-page capture can blank its plugin surface.
return await tab.screenshot({ silent: true });
`;

export interface PdfImageReadTarget {
	pdfPath: string;

	member: string;

	page: number;
}

export function splitPdfImageReadPath(readPath: string): PdfImageReadTarget | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	const pdfPath = match?.[1];
	const member = match?.[2];
	if (!pdfPath || member === undefined) return null;
	const pageText = PDF_PAGE_MEMBER_RE.exec(member)?.[1];
	if (pageText === undefined) return null;
	const page = Number(pageText);
	if (!Number.isSafeInteger(page) || page < 1) return null;
	return { pdfPath, member, page };
}

/** Serve only the requested PDF: shared/Snap Chromium cannot read the caller's filesystem. */
export function servePdfForBrowser(absolutePdfPath: string): { server: Bun.Server<undefined>; url: URL } {
	const resourcePath = `/${Bun.randomUUIDv7()}.pdf`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname !== resourcePath) return new Response(null, { status: 404 });
			if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
			return new Response(Bun.file(absolutePdfPath), { headers: { "content-type": "application/pdf" } });
		},
	});
	return { server, url: new URL(resourcePath, server.url) };
}

export async function renderPdfPageScreenshot(
	session: ToolSession,
	absolutePdfPath: string,
	page: number,
	signal?: AbortSignal,
): Promise<ScreenshotResult> {
	const [{ acquireBrowser, holdBrowser, releaseBrowser }, { acquireTab, releaseTab, runInTab }] = await Promise.all([
		import("./browser/registry"),
		import("./browser/tab-supervisor"),
	]);
	const timeoutSignal = AbortSignal.timeout(PDF_RENDER_TIMEOUT_MS);
	const renderSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const tabName = `read-pdf-${Bun.randomUUIDv7()}`;
	const { server, url: pdfUrl } = servePdfForBrowser(absolutePdfPath);
	pdfUrl.hash = `page=${page}&toolbar=0&navpanes=0&view=Fit`;

	let browserLease = false;
	let tabOpened = false;
	let browser: BrowserHandle | undefined;
	try {
		const acquiredBrowser = await untilAborted(renderSignal, () =>
			acquireBrowser({ kind: "headless", headless: true }, { cwd: session.cwd, signal: renderSignal }),
		);
		browser = acquiredBrowser;
		holdBrowser(acquiredBrowser);
		browserLease = true;
		await untilAborted(renderSignal, () =>
			acquireTab(tabName, acquiredBrowser, {
				url: pdfUrl.href,
				waitUntil: "load",
				timeoutMs: PDF_RENDER_TIMEOUT_MS,
				signal: renderSignal,
				ownerSessionId: session.getSessionId?.() ?? undefined,
			}),
		);
		tabOpened = true;
		await releaseBrowser(acquiredBrowser, { kill: false });
		browserLease = false;

		const result = await runInTab(tabName, {
			code: PDF_SCREENSHOT_CODE,
			timeoutMs: PDF_RENDER_TIMEOUT_MS,
			signal: renderSignal,
			session,
		});
		const screenshot = result.screenshots.at(-1);
		if (!screenshot) throw new ToolError(`Chromium did not capture PDF page ${page}.`);
		return screenshot;
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (timeoutSignal.aborted) {
			throw new ToolError(`Timed out rendering PDF page ${page} in Chromium.`);
		}
		throw error;
	} finally {
		try {
			if (tabOpened) await releaseTab(tabName, { kill: false });
			if (browserLease && browser) await releaseBrowser(browser, { kill: false });
		} finally {
			server.stop(true);
		}
	}
}
