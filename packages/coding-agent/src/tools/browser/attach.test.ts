import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Browser, Page, Target } from "puppeteer-core";
import {
	attachPageWithTimeout,
	findReusableCdp,
	gracefulKillTreeOnce,
	pickElectronTarget,
	probeCdpResponse,
	resolveSpawnArgs,
} from "./attach";
import { acquireBrowser } from "./registry";

describe("spawned app reuse", () => {
	let tempDir: string;
	let executable: string;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-browser-app-path-"));
		const copy = path.join(tempDir, path.basename(process.execPath));
		await Bun.write(copy, Bun.file(process.execPath));
		await fs.chmod(copy, 0o755);
		executable = await fs.realpath(copy);
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function spawnExisting(args: string[] = []): Promise<{ pid: number; close(): Promise<void> }> {
		const child = Bun.spawn(
			[executable, "--eval", 'process.stdout.write("ready\\n"); await Bun.stdin.text()', ...args],
			{ stdin: "pipe", stdout: "pipe", stderr: "ignore" },
		);
		const readiness = child.stdout.getReader();
		await readiness.read();
		readiness.releaseLock();
		return {
			pid: child.pid,
			async close() {
				await gracefulKillTreeOnce(child.pid);
				await child.exited;
			},
		};
	}

	test("refuses to replace a running same-executable process", async () => {
		const existing = await spawnExisting();
		try {
			await expect(
				acquireBrowser(
					{ kind: "spawned", path: executable },
					{ cwd: process.cwd(), signal: AbortSignal.timeout(2_000) },
				),
			).rejects.toThrow("already running without a reusable CDP endpoint");
			expect(Process.fromPid(existing.pid)?.status()).toBe(ProcessStatus.Running);
		} finally {
			await existing.close();
		}
	}, 10_000);

	test("reuses a live CDP endpoint only for the requested profile", async () => {
		const cdp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}") });
		const profile = path.join(tempDir, "profile");
		const existing = await spawnExisting([`--user-data-dir=${profile}`, `--remote-debugging-port=${cdp.port}`]);
		try {
			expect(await findReusableCdp(executable, { appArgs: [`--user-data-dir=${profile}-other`] })).toBeNull();
			expect(await findReusableCdp(executable, { appArgs: [`--user-data-dir=${profile}`] })).toEqual({
				cdpUrl: `http://127.0.0.1:${cdp.port}`,
				pid: existing.pid,
			});
		} finally {
			await existing.close();
			cdp.stop(true);
		}
	}, 10_000);
});

describe("resolveSpawnArgs", () => {
	test("normalizes separated and relative Chromium profiles into an absolute switch value", () => {
		const args = resolveSpawnArgs(
			"/usr/bin/google-chrome-stable",
			["--user-data-dir", "profile", "--incognito"],
			"/tmp",
		);
		expect(args).toEqual(["--incognito", `--user-data-dir=${path.resolve("/tmp", "profile")}`]);
	});

	test("isolates Chromium launchers on a proto-owned profile and leaves other apps untouched", () => {
		const args = resolveSpawnArgs("/var/lib/flatpak/exports/bin/com.google.Chrome", []);
		expect(args).toContain("--no-first-run");
		expect(args.some(arg => arg.startsWith("--user-data-dir="))).toBe(true);
		expect(resolveSpawnArgs("/Applications/Slack.app/Contents/MacOS/Slack", ["--foo"])).toEqual(["--foo"]);
	});
});

function fakePage(id: string, url: string, title = id): Page {
	return {
		url: () => url,
		title: async () => title,
		target: () => ({ _targetId: id }),
		evaluate: async () => false,
	} as unknown as Page;
}
function fakeTarget(id: string, page: Page): Target {
	return { _targetId: id, type: () => "page", page: async () => page } as unknown as Target;
}
function fakeBrowser(targets: Target[], pages: Page[] = []): Browser {
	return { targets: () => targets, pages: async () => pages } as unknown as Browser;
}

describe("attached page selection", () => {
	test("an exact direct CDP id wins over another page whose URL contains that id", async () => {
		const misleading = fakePage("other", "https://example.com/PAGE1");
		const exact = fakePage("PAGE1", "https://chosen.example/");
		const selected = await pickElectronTarget(
			fakeBrowser([fakeTarget("other", misleading), fakeTarget("PAGE1", exact)]),
			{ matcher: "PAGE1" },
		);
		expect(selected.url()).toBe("https://chosen.example/");
	});

	test("an exact relay id wins over a substring match and does not probe an unrelated page", async () => {
		let wrongProbes = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json([
					{ id: "other", type: "page", title: "Other", url: "https://example.com/PAGE1" },
					{ id: "PAGE1", type: "page", title: "Chosen", url: "https://chosen.example/" },
				]),
		});
		const exact = fakePage("PAGE1", "https://chosen.example/");
		const wrong = {
			_targetId: "other",
			type: () => "page",
			page: async () => {
				wrongProbes++;
				return fakePage("other", "wrong");
			},
		} as unknown as Target;
		try {
			const selected = await pickElectronTarget(fakeBrowser([wrong, fakeTarget("PAGE1", exact)]), {
				matcher: "PAGE1",
				relayJson: server.url.origin,
			});
			expect(selected.url()).toBe("https://chosen.example/");
			expect(wrongProbes).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	test("waits for a newly opened tab's metadata instead of rejecting its match immediately", async () => {
		let polls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json([
					{ id: "PAGE1", type: "page", title: ++polls < 2 ? "Loading" : "Invoice", url: "about:blank" },
				]),
		});
		try {
			const selected = await pickElectronTarget(
				fakeBrowser([fakeTarget("PAGE1", fakePage("PAGE1", "https://invoice.example/"))]),
				{ matcher: "Invoice", relayJson: server.url.origin, signal: AbortSignal.timeout(500) },
			);
			expect(selected.url()).toBe("https://invoice.example/");
			expect(polls).toBe(2);
		} finally {
			server.stop(true);
		}
	});

	test("falls back immediately for empty relay metadata without consuming the matcher settle window", async () => {
		let polls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				polls++;
				return Response.json([]);
			},
		});
		try {
			const selected = await pickElectronTarget(
				fakeBrowser([fakeTarget("page", fakePage("page", "https://invoice.example/"))]),
				{ matcher: "invoice", relayJson: server.url.origin, signal: AbortSignal.timeout(150) },
			);
			expect(selected.url()).toBe("https://invoice.example/");
			expect(polls).toBe(1);
		} finally {
			server.stop(true);
		}
	});

	test("propagates cancellation during metadata settling rather than reporting no match", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json([{ id: "page", type: "page", title: "Loading", url: "about:blank" }]),
		});
		const controller = new AbortController();
		const cancelled = new Error("caller deadline reached");
		const timeout = setTimeout(() => controller.abort(cancelled), 30);
		try {
			await expect(
				pickElectronTarget(fakeBrowser([]), {
					matcher: "invoice",
					relayJson: server.url.origin,
					signal: controller.signal,
				}),
			).rejects.toThrow("aborted");
		} finally {
			clearTimeout(timeout);
			server.stop(true);
		}
	});

	test("does not fall through to another tab when the explicitly selected relay tab was discarded", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				Response.json([
					{ id: "page", type: "page", title: "Invoice", url: "https://invoice.example", discarded: "true" },
				]),
		});
		try {
			await expect(
				pickElectronTarget(fakeBrowser([fakeTarget("other", fakePage("other", "https://other.example"))]), {
					matcher: "Invoice",
					relayJson: server.url.origin,
				}),
			).rejects.toThrow("discarded");
		} finally {
			server.stop(true);
		}
	});

	test("bounds a target whose page attachment never resolves", async () => {
		const pending = Promise.withResolvers<Page | null>();
		const target = { page: () => pending.promise } as unknown as Target;
		expect(await attachPageWithTimeout(target, 10)).toBeNull();
	});

	test("reads complete proxy-free CDP response bodies for relay capability discovery", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ extensionSeen: false, uptimeMs: 50_000 }, { status: 503 }),
		});
		try {
			const response = await probeCdpResponse(server.url.origin, { timeoutMs: 500 });
			expect(response?.status).toBe(503);
			expect(JSON.parse(response!.body)).toEqual({ extensionSeen: false, uptimeMs: 50_000 });
		} finally {
			server.stop(true);
		}
	});
});
