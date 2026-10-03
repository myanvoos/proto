import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { getBrowserProfilesDir } from "@oh-my-pi/pi-utils";
import type { Socket } from "bun";
import type { Browser, Page } from "puppeteer-core";
import { ToolError, throwIfAborted } from "../tool-errors";

const ATTACH_TARGET_SKIP_PATTERN =
	/request[\s_-]?handler|devtools|background[\s_-]?(?:page|host)|service[\s_-]?worker/i;

export async function findFreeCdpPort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = net.createServer();
	server.unref();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const addr = server.address();
		if (addr && typeof addr === "object" && typeof addr.port === "number") {
			const port = addr.port;
			server.close(closeErr => (closeErr ? reject(closeErr) : resolve(port)));
		} else {
			server.close();
			reject(new Error("Failed to allocate ephemeral CDP port"));
		}
	});
	return promise;
}

export async function probeCdpStatus(
	url: string,
	opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<number | null> {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return null;
	}
	if (opts.signal?.aborted) return null;
	const port = target.port ? Number(target.port) : 80;
	const requestPath = `${target.pathname}${target.search}` || "/";
	const { promise, resolve } = Promise.withResolvers<number | null>();
	let socket: Socket<undefined> | undefined;
	let settled = false;
	const finish = (status: number | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		try {
			socket?.end();
		} catch {}
		resolve(status);
	};
	const onAbort = () => finish(null);
	const timer = setTimeout(() => finish(null), opts.timeoutMs);
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	let buffered = "";
	try {
		socket = await Bun.connect({
			hostname: target.hostname,
			port,
			socket: {
				open(s) {
					s.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\nConnection: close\r\n\r\n`);
				},
				data(_s, chunk) {
					buffered += chunk.toString("latin1");
					const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buffered);
					if (match) finish(Number(match[1]));
				},
				error() {
					finish(null);
				},
				close() {
					finish(null);
				},
			},
		});
	} catch {
		finish(null);
	}
	return promise;
}

export async function waitForCdp(cdpUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	const probeUrl = `${cdpUrl.replace(/\/+$/, "")}/json/version`;
	let lastStatus: number | null = null;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		const status = await probeCdpStatus(probeUrl, { timeoutMs: 2000, signal });
		if (status !== null && status >= 200 && status < 300) return;
		lastStatus = status;
		await Bun.sleep(150);
	}
	throwIfAborted(signal);
	throw new ToolError(
		`Timed out waiting for CDP endpoint ${cdpUrl}${lastStatus !== null ? `: HTTP ${lastStatus}` : ""}`,
	);
}

function findCdpPortInArgs(args: string[]): number | null {
	for (const arg of args) {
		const m = /^--remote-debugging-port=(\d+)$/.exec(arg);
		if (m) {
			const port = Number.parseInt(m[1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--remote-debugging-port") {
			const port = Number.parseInt(args[i + 1]!, 10);
			if (Number.isFinite(port) && port > 0) return port;
		}
	}
	return null;
}

function findUserDataDirInArgs(args: string[] | undefined): string | null {
	if (!args) return null;
	let result: string | null = null;
	const inlinePrefix = "--user-data-dir=";
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg.startsWith(inlinePrefix)) {
			result = arg.length > inlinePrefix.length ? arg.slice(inlinePrefix.length) : null;
			continue;
		}
		if (arg !== "--user-data-dir") continue;
		const value = args[index + 1];
		result = value !== undefined && value.length > 0 && !value.startsWith("--") ? value : null;
		if (result !== null) index++;
	}
	return result;
}

/** Chromium-family browser basenames (channels and vendor suffixes included), as opposed to Electron apps. */
const CHROMIUM_BROWSER_BASENAME =
	/^(?:google[ -]chrome|chrome|chromium|microsoft[ -]edge|msedge|brave|vivaldi|opera|thorium|ungoogled[ -]chromium)(?:[ -](?:beta|dev|canary|unstable|stable|nightly|snapshot|browser|gx|for[ -]testing))*$/i;
const CHROMIUM_FLATPAK_IDS: Record<string, true> = {
	"com.google.Chrome": true,
	"org.chromium.Chromium": true,
	"io.github.ungoogled_software.ungoogled_chromium": true,
};

function isChromiumBrowser(exe: string): boolean {
	const base = path.basename(exe);
	return CHROMIUM_BROWSER_BASENAME.test(base) || Object.hasOwn(CHROMIUM_FLATPAK_IDS, base);
}

/**
 * Launch argv for a spawned executable. Chrome 136+ silently ignores `--remote-debugging-port` on the default
 * user-data-dir, so Chromium-family browsers get a stable proto-owned profile unless the caller picked one; that also
 * lets a second instance start beside the user's running browser instead of handing off to it. A caller profile is
 * canonicalized to an absolute `--user-data-dir=` so reuse matching and launch agree. Electron apps are untouched:
 * `--user-data-dir` would relocate their app data.
 */
export function resolveSpawnArgs(exe: string, appArgs: string[] | undefined, cwd = process.cwd()): string[] {
	const args = appArgs ?? [];
	if (!isChromiumBrowser(exe)) return args;
	const requestedProfile = findUserDataDirInArgs(args);
	if (requestedProfile !== null) {
		const launchArgs: string[] = [];
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "--user-data-dir") {
				if (args[index + 1] && !args[index + 1]!.startsWith("--")) index++;
			} else if (!arg.startsWith("--user-data-dir=")) {
				launchArgs.push(arg);
			}
		}
		launchArgs.push(`--user-data-dir=${path.resolve(cwd, requestedProfile)}`);
		return launchArgs;
	}
	const slug = path
		.basename(exe)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
	const hash = Bun.hash.wyhash(exe).toString(16).padStart(16, "0");
	const launchArgs = [...args];
	// A fresh profile otherwise opens the welcome tour and default-browser prompt as extra page targets.
	if (!args.includes("--no-first-run")) launchArgs.push("--no-first-run");
	if (!args.includes("--no-default-browser-check")) launchArgs.push("--no-default-browser-check");
	launchArgs.push(`--user-data-dir=${path.join(getBrowserProfilesDir(), `${slug}-${hash}`)}`);
	return launchArgs;
}

async function probeCdpAt(port: number, signal?: AbortSignal): Promise<boolean> {
	const status = await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1500, signal });
	return status !== null && status >= 200 && status < 300;
}

/**
 * Resolve a distro wrapper script (e.g. /opt/google/chrome/google-chrome ending in `exec -a "$0" "$HERE/chrome" "$@"`)
 * to its final `exec ... $HERE/...` target. Null for binaries and wrappers without one; size-guarded so real binaries
 * are never read.
 */
async function resolveWrapperTarget(wrapperPath: string): Promise<string | null> {
	const stat = await fs.stat(wrapperPath).catch(() => null);
	if (!stat?.isFile() || stat.size > 65_536) return null;
	const content = await Bun.file(wrapperPath)
		.text()
		.catch(() => null);
	if (!content || content.charCodeAt(0) === 0x7f) return null;
	let target: string | null = null;
	const execRegex = /^\s*exec\s+(?:-a\s+(?:"[^"]*"|'[^']*'|\S+)\s+)?["']?\$(?:HERE|\{HERE\})\/([^\s"'`;}]+)/;
	for (const line of content.split("\n")) {
		const match = execRegex.exec(line);
		if (match?.[1]) target = match[1];
	}
	if (!target) return null;
	const joined = path.join(path.dirname(wrapperPath), target);
	return fs.realpath(joined).catch(() => joined);
}

/**
 * Unglue argv from kernels that serve /proc/<pid>/cmdline space-joined in argv[0] (Chromium's setproctitle), which
 * would hide `--user-data-dir`/`--remote-debugging-port`. Only safe when every `--user-data-dir` value re-parses
 * identically; a profile path with spaces stays glued so it can never match another profile.
 */
function normalizeCandidateArgs(args: string[]): string[] {
	if (args.length !== 1 || !args[0]!.includes(" --")) return args;
	const word = args[0]!;
	const split = word.trim().split(/\s+/);
	if (split.length <= 1) return args;
	const flagRegex = /(?:^|\s)--user-data-dir(?:=(.*?)|(?:\s+(.*?))?)(?=\s--|$)/g;
	const rawMatches = [...word.trim().replace(/\s+/g, " ").matchAll(flagRegex)];
	if (rawMatches.length > 0) {
		let matchIndex = 0;
		for (let i = 0; i < split.length; i++) {
			const arg = split[i]!;
			if (arg.startsWith("--user-data-dir=")) {
				const expected = rawMatches[matchIndex]?.[1] ?? rawMatches[matchIndex]?.[2] ?? "";
				if (findUserDataDirInArgs(split.slice(i, i + 1)) !== expected) return args;
				matchIndex++;
			} else if (arg === "--user-data-dir") {
				const expected = rawMatches[matchIndex]?.[1] ?? rawMatches[matchIndex]?.[2] ?? "";
				if (findUserDataDirInArgs(split.slice(i, i + 2)) !== expected) return args;
				matchIndex++;
				i++;
			}
		}
		if (matchIndex !== rawMatches.length) return args;
	}
	return split;
}

/**
 * Reusable CDP endpoint of a running `exe` (matching the requested profile, if any), or null when none runs. An
 * occupied executable without a reusable endpoint is never killed: launching beside it is allowed only for a distinct,
 * absolute `--user-data-dir`; otherwise this throws.
 */
export async function findReusableCdp(
	exe: string,
	options: { signal?: AbortSignal; appArgs?: string[] } = {},
): Promise<{ cdpUrl: string; pid: number } | null> {
	const requestedUserDataDir = findUserDataDirInArgs(options.appArgs);
	const normalizedRequestedUserDataDir =
		requestedUserDataDir !== null && path.isAbsolute(requestedUserDataDir)
			? path.resolve(requestedUserDataDir)
			: null;
	// Process paths are real paths; distro wrapper scripts additionally hide the exec'd Chromium binary.
	const executablePath = await fs.realpath(exe).catch(() => exe);
	const wrapperTarget =
		process.platform === "linux" && isChromiumBrowser(exe) ? await resolveWrapperTarget(executablePath) : null;
	const candidates = Process.fromPath(wrapperTarget ?? executablePath).filter(
		candidate => candidate.status() === ProcessStatus.Running,
	);
	const candidateArgs: string[][] = [];
	let hasUnreadableCandidate = false;
	for (const candidate of candidates) {
		let args: string[];
		try {
			args = normalizeCandidateArgs(candidate.args());
		} catch {
			hasUnreadableCandidate = true;
			continue;
		}
		candidateArgs.push(args);
		const candidateProfile = findUserDataDirInArgs(args);
		if (
			requestedUserDataDir !== null &&
			(normalizedRequestedUserDataDir === null ||
				candidateProfile === null ||
				!path.isAbsolute(candidateProfile) ||
				path.resolve(candidateProfile) !== normalizedRequestedUserDataDir)
		) {
			continue;
		}
		const port = findCdpPortInArgs(args);
		if (port === null) continue;
		if (await probeCdpAt(port, options.signal)) {
			return { cdpUrl: `http://127.0.0.1:${port}`, pid: candidate.pid };
		}
	}
	const canLaunchIsolatedProfile =
		normalizedRequestedUserDataDir !== null &&
		!hasUnreadableCandidate &&
		candidateArgs.every(args => {
			const existingUserDataDir = findUserDataDirInArgs(args);
			return (
				existingUserDataDir === null ||
				(path.isAbsolute(existingUserDataDir) &&
					path.resolve(existingUserDataDir) !== normalizedRequestedUserDataDir)
			);
		});
	if (!canLaunchIsolatedProfile && candidates.length > 0) {
		const name = path.basename(exe);
		throw new ToolError(
			`Cannot launch ${name} because it is already running without a reusable CDP endpoint. Close ${name}, relaunch it with --remote-debugging-port, or pass app.cdp_url for an existing endpoint.`,
		);
	}
	return null;
}

export function shouldPreserveConnectedBrowserFocus(target?: string): boolean {
	return !target;
}

export async function pickElectronTarget(
	browser: Browser,
	options: { matcher?: string; preferVisible?: boolean } = {},
): Promise<Page> {
	const discoveredPages = await Promise.all(
		browser.targets().map(async target => {
			if (String(target.type()) !== "page") return null;
			return await target.page().catch(() => null);
		}),
	);
	const usablePages = discoveredPages.filter((page): page is Page => page !== null);
	if (usablePages.length > 0) {
		return pickPageFromList(usablePages, options);
	}

	const fallbackPages = await browser.pages();
	if (!fallbackPages.length) {
		throw new ToolError("No page targets available on the attached browser");
	}
	return pickPageFromList(fallbackPages, options);
}

async function enrichPages(pages: Page[]): Promise<Array<{ page: Page; url: string; title: string }>> {
	return await Promise.all(
		pages.map(async page => ({
			page,
			url: page.url(),
			title: ((await page.title().catch(() => "")) ?? "").trim(),
		})),
	);
}

async function pickPageFromList(pages: Page[], options: { matcher?: string; preferVisible?: boolean }): Promise<Page> {
	const enriched = await enrichPages(pages);
	if (options.matcher) {
		const needle = options.matcher.toLowerCase();
		const hit = enriched.find(p => p.url.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle));
		if (hit) return hit.page;
		const summary = enriched.map(p => `- ${p.title || "(untitled)"}  ${p.url}`).join("\n");
		throw new ToolError(`No page target matched ${JSON.stringify(options.matcher)}. Available pages:\n${summary}`);
	}
	const usable = enriched.filter(
		p => !ATTACH_TARGET_SKIP_PATTERN.test(p.url) && !ATTACH_TARGET_SKIP_PATTERN.test(p.title),
	);
	if (options.preferVisible && usable.length > 1) {
		const visibility = await Promise.all(
			usable.map(async p => {
				try {
					return (await p.page.evaluate(() => document.visibilityState === "visible")) === true;
				} catch {
					return false;
				}
			}),
		);
		const foreground = visibility.indexOf(true);
		if (foreground >= 0) return usable[foreground]!.page;
	}
	return usable[0]?.page ?? enriched[0]!.page;
}

export async function gracefulKillTreeOnce(pid: number, gracePeriodMs = 2000): Promise<void> {
	const process = Process.fromPid(pid);
	if (!process) return;
	await process.terminate({ gracefulMs: gracePeriodMs, timeoutMs: 500 });
}
