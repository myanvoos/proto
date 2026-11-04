import { afterAll, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { ensureChromiumExecutable } from "./launch";

interface PageGlobals {
	protoWorldMarker?: string;
}

let browser: Browser;
beforeAll(async () => {
	browser = await puppeteer.launch({
		executablePath: await ensureChromiumExecutable(),
		headless: true,
		args: ["--no-sandbox"],
	});
}, 60_000);
afterAll(async () => {
	await browser?.close();
});

test("patched Puppeteer keeps evaluations isolated unless callbacks explicitly select the page world", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent('<button id="button">Go</button><script>globalThis.protoWorldMarker="page"</script>');
		expect(await page.evaluate(() => (globalThis as PageGlobals).protoWorldMarker)).toBeUndefined();
		expect(
			await page.evaluate(() => {
				/*!world=main*/ return (globalThis as PageGlobals).protoWorldMarker;
			}),
		).toBe("page");
		expect(await page.evaluate("//!world=main\nglobalThis.protoWorldMarker")).toBe("page");
		expect(await page.$eval("button", () => (globalThis as PageGlobals).protoWorldMarker)).toBeUndefined();
		expect(
			await page.$eval("button", () => {
				/*!world=main*/ return (globalThis as PageGlobals).protoWorldMarker;
			}),
		).toBe("page");
		expect(
			await page.$$eval("button", elements => [
				elements.length,
				(globalThis as PageGlobals).protoWorldMarker ?? null,
			]),
		).toEqual([1, null]);
		expect(
			await page.$$eval("button", elements => {
				/*!world=main*/ return [elements.length, (globalThis as PageGlobals).protoWorldMarker];
			}),
		).toEqual([1, "page"]);
		const handle = await page.waitForSelector("button");
		if (!handle) throw new Error("Expected fixture button");
		expect(await page.evaluate(element => element?.id, handle)).toBe("button");
		expect(
			await handle.evaluate(() => {
				/*!world=main*/ return (globalThis as PageGlobals).protoWorldMarker;
			}),
		).toBe("page");
		expect(await handle.evaluate(() => (globalThis as PageGlobals).protoWorldMarker)).toBeUndefined();
		expect(await page.evaluate(() => new Error("probe").stack)).not.toContain("__puppeteer_evaluation_script__");
		await page.locator("button").click();
		await handle.dispose();
	} finally {
		await page.close();
	}
});

test("patched Puppeteer reacquires the correct isolated and main worlds after frame navigation", async () => {
	const page = await browser.newPage();
	try {
		await page.goto('data:text/html,<script>globalThis.protoWorldMarker="first"</script>');
		expect(
			await page.evaluate(() => {
				/*!world=main*/ return (globalThis as PageGlobals).protoWorldMarker;
			}),
		).toBe("first");
		await page.goto(
			`data:text/html,<script>globalThis.protoWorldMarker="second"</script><iframe srcdoc="<script>globalThis.protoWorldMarker='child'</script>"></iframe>`,
		);
		expect(await page.evaluate(() => (globalThis as PageGlobals).protoWorldMarker)).toBeUndefined();
		expect(
			await page.evaluate(() => {
				/*!world=main*/ return (globalThis as PageGlobals).protoWorldMarker;
			}),
		).toBe("second");
		const frame = page.frames().find(frame => frame.parentFrame());
		if (!frame) throw new Error("Expected fixture child frame");
		expect(await frame.evaluate(() => (globalThis as PageGlobals).protoWorldMarker)).toBeUndefined();
		expect(
			await frame.evaluate(() => {
				/*!world=main*/ return (globalThis as PageGlobals).protoWorldMarker;
			}),
		).toBe("child");
	} finally {
		await page.close();
	}
});
