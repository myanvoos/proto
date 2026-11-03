import { afterAll, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer-core";
import { ensureChromiumExecutable } from "../launch";
import { buildAriaSnapshotScript, captureAriaSnapshot } from "./aria-snapshot";

// Browser-realm callback contracts only; do not enable lib.dom for the Bun host.
interface SnapshotElement extends Element {
	attachShadow(options: { mode: "open" }): SnapshotElement;
}
interface SnapshotInput extends SnapshotElement {
	hidden: boolean;
}
interface SnapshotFrame extends SnapshotElement {
	contentDocument: SnapshotDocument | null;
}
interface SnapshotDocument {
	body: SnapshotElement;
	querySelector(selector: string): SnapshotElement | null;
	getElementById(id: string): SnapshotElement | null;
	createElement(tag: "input"): SnapshotInput;
	createElement(tag: "iframe"): SnapshotFrame;
	createElement(tag: string): SnapshotElement;
}
declare const document: SnapshotDocument;
declare const HTMLInputElement: { prototype: SnapshotInput };

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

test("ARIA snapshots hide passwords, including overlapping pinned values, and restore page accessors", async () => {
	const page = await browser.newPage();
	try {
		await page.setContent(
			'<form><label>Password<input id="password" type="password"></label><input id="normal" value="public@example.test"><button aria-labelledby="password"></button></form>',
		);
		const secret = 'secret "q" \\ x  y: it\'s\x01';
		await page.evaluate(secret => {
			const form = document.querySelector("form")!;
			const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
			const pw = document.getElementById("password") as SnapshotInput;
			pw.value = secret;
			Object.defineProperty(pw, "value", { configurable: true, get: native.get, set: native.set });
			for (const [id, value] of [
				["pinned", secret],
				["longer", `${secret}-longer`],
				["ovl1", "k9 ab"],
				["ovl2", "abX4"],
				["sealed", `${secret}-sealed`],
			]) {
				const input = form.appendChild(document.createElement("input"));
				input.type = "password";
				input.id = id;
				input.setAttribute("aria-label", id);
				input.value = value;
				if (id === "sealed") Object.preventExtensions(input);
				else Object.defineProperty(input, "value", { get: native.get });
				form.appendChild(document.createElement("button")).setAttribute("aria-labelledby", id);
			}
			const pub = form.appendChild(document.createElement("span"));
			pub.id = "pub";
			pub.textContent = "k9";
			form.appendChild(document.createElement("button")).setAttribute("aria-labelledby", "pub ovl2");
			const frame = document.body.appendChild(document.createElement("iframe"));
			const adopted = frame.contentDocument!.createElement("input");
			adopted.type = "password";
			adopted.value = `${secret}-adopted`;
			form.appendChild(adopted);
			const shadow = document.body.appendChild(document.createElement("div")).attachShadow({ mode: "open" });
			const shadowInput = shadow.appendChild(document.createElement("input"));
			shadowInput.type = "password";
			shadowInput.value = `${secret}-shadow`;
			const broken = form.appendChild(document.createElement("input"));
			broken.type = "password";
			broken.hidden = true;
			Object.defineProperty(broken, "value", {
				configurable: true,
				get() {
					throw new Error("page accessor");
				},
			});
		}, secret);
		const snapshot = await captureAriaSnapshot(page, null);
		expect(snapshot).toContain("public@example.test");
		expect(snapshot).toContain("•".repeat(secret.length));
		expect(snapshot).toContain(`button "${"•".repeat(secret.length + 7)}"`);
		expect(snapshot).not.toContain("secret");
		expect(snapshot).not.toContain("X4");
		const restored = await page.evaluate(secret => {
			const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
			const input = document.getElementById("password") as SnapshotInput;
			return (
				input.value === secret &&
				Object.getOwnPropertyDescriptor(input, "value")?.get === native.get &&
				(document.getElementById("pinned") as SnapshotInput).value === secret
			);
		}, secret);
		expect(restored).toBe(true);
		// The page-world path used by frame and attached-browser snapshots has the same guarantees.
		const script = buildAriaSnapshotScript("form");
		const pageWorld = await page.evaluate(script => globalThis.eval(script) as string, script);
		expect(pageWorld).not.toContain("secret");
		expect(pageWorld).not.toContain("X4");
	} finally {
		await page.close();
	}
});

test("XHTML password inputs are masked despite their lowercase tag names", async () => {
	const page = await browser.newPage();
	try {
		await page.goto(
			`data:application/xhtml+xml,${encodeURIComponent('<html xmlns="http://www.w3.org/1999/xhtml"><body><label>Password<input id="pw" type="password"/></label></body></html>')}`,
		);
		await page.$eval("#pw", input => {
			(input as SnapshotInput).value = "Xhtml-Secret-4417";
		});
		const snapshot = await captureAriaSnapshot(page, null);
		expect(snapshot).not.toContain("Xhtml-Secret");
		expect(snapshot).toContain("•".repeat("Xhtml-Secret-4417".length));
		expect(await page.$eval("#pw", input => (input as SnapshotInput).value)).toBe("Xhtml-Secret-4417");
	} finally {
		await page.close();
	}
});
