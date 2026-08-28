import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, getPuppeteerDir, logger, removeWithRetries } from "@oh-my-pi/pi-utils";
import type * as BrowsersNs from "@oh-my-pi/pi-utils/browsers";
import type { Browser, CDPSession, Page, default as Puppeteer, Target } from "puppeteer-core";
import stealthTamperingScript from "../puppeteer/00_stealth_tampering.txt" with { type: "text" };
import stealthActivityScript from "../puppeteer/01_stealth_activity.txt" with { type: "text" };
import stealthHairlineScript from "../puppeteer/02_stealth_hairline.txt" with { type: "text" };
import stealthBotdScript from "../puppeteer/03_stealth_botd.txt" with { type: "text" };
import stealthIframeScript from "../puppeteer/04_stealth_iframe.txt" with { type: "text" };
import stealthWebglScript from "../puppeteer/05_stealth_webgl.txt" with { type: "text" };
import stealthScreenScript from "../puppeteer/06_stealth_screen.txt" with { type: "text" };
import stealthFontsScript from "../puppeteer/07_stealth_fonts.txt" with { type: "text" };
import stealthAudioScript from "../puppeteer/08_stealth_audio.txt" with { type: "text" };
import stealthLocaleScript from "../puppeteer/09_stealth_locale.txt" with { type: "text" };
import stealthPluginsScript from "../puppeteer/10_stealth_plugins.txt" with { type: "text" };
import stealthHardwareScript from "../puppeteer/11_stealth_hardware.txt" with { type: "text" };
import stealthCodecsScript from "../puppeteer/12_stealth_codecs.txt" with { type: "text" };
import stealthWorkerScript from "../puppeteer/13_stealth_worker.txt" with { type: "text" };
import { ToolError } from "../tool-errors";

export const DEFAULT_VIEWPORT = { width: 1365, height: 768, deviceScaleFactor: 1.25 };

export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;
const ENABLE_AUTOMATION_FLAG = "--enable-automation";

const STEALTH_IGNORE_DEFAULT_ARGS = [
	ENABLE_AUTOMATION_FLAG,
	"--disable-extensions",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
	"--disable-popup-blocking",
	"--disable-client-side-phishing-detection",
	"--allow-pre-commit-input",
	"--disable-ipc-flooding-protection",
	"--metrics-recording-only",
];

function isMicrosoftEdgeExecutable(executablePath: string | undefined): boolean {
	if (!executablePath) return false;
	const normalizedPath = executablePath.replaceAll("\\", "/").toLowerCase();
	const executableName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	return (
		executableName === "msedge.exe" ||
		executableName === "microsoft edge" ||
		executableName.startsWith("microsoft-edge")
	);
}

function stealthIgnoreDefaultArgs(executablePath: string | undefined): string[] {
	if (!isMicrosoftEdgeExecutable(executablePath)) return [...STEALTH_IGNORE_DEFAULT_ARGS];
	return STEALTH_IGNORE_DEFAULT_ARGS.filter(arg => arg !== ENABLE_AUTOMATION_FLAG);
}

const STEALTH_ACCEPT_LANGUAGE = "en-US,en";

const USER_AGENT_TARGET_TIMEOUT_MS = 5_000;
const USER_AGENT_TARGET_TYPES = new Set(["page", "webview", "background_page"]);
const PUPPETEER_SOURCE_URL_SUFFIX = "//# sourceURL=__puppeteer_evaluation_script__";

let puppeteerModule: typeof Puppeteer | undefined;
export async function loadPuppeteer(): Promise<typeof Puppeteer> {
	if (puppeteerModule) return puppeteerModule;
	const prev = process.cwd();
	const safeDir = getPuppeteerDir();
	await Bun.write(path.join(safeDir, "package.json"), "{}");
	try {
		process.chdir(safeDir);
		puppeteerModule = (await import("puppeteer-core")).default;
		return puppeteerModule;
	} finally {
		process.chdir(prev);
	}
}

let puppeteerModuleWorker: typeof Puppeteer | undefined;
export async function loadPuppeteerInWorker(safeDir: string): Promise<typeof Puppeteer> {
	if (puppeteerModuleWorker) return puppeteerModuleWorker;
	const orig = process.cwd;
	Object.defineProperty(process, "cwd", { value: () => safeDir, configurable: true });
	try {
		puppeteerModuleWorker = (await import("puppeteer-core")).default;
		return puppeteerModuleWorker;
	} finally {
		Object.defineProperty(process, "cwd", { value: orig, configurable: true });
	}
}

let browsersModule: typeof BrowsersNs | undefined;
async function loadBrowsers(): Promise<typeof BrowsersNs> {
	if (!browsersModule) {
		browsersModule = await import("@oh-my-pi/pi-utils/browsers");
	}
	return browsersModule;
}

let chromiumExecutablePromise: Promise<string | undefined> | undefined;
export async function ensureChromiumExecutable(): Promise<string | undefined> {
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath) return envPath;

	const preferManagedChromium = process.platform === "darwin";
	if (!preferManagedChromium) {
		const sysChrome = await resolveSystemChromium();
		if (sysChrome) return sysChrome;
	}

	chromiumExecutablePromise ??= (async () => {
		const browsers = await loadBrowsers();
		const platform = browsers.detectBrowserPlatform();
		if (!platform) {
			logger.warn("Could not detect browser platform; relying on puppeteer default resolution");
			return undefined;
		}
		const cacheDir = getPuppeteerDir();
		const { PUPPETEER_REVISIONS } = await import("puppeteer-core/internal/revisions.js");
		const buildId = await browsers.resolveBuildId(browsers.Browser.CHROME, platform, PUPPETEER_REVISIONS.chrome);
		const executablePath = browsers.computeExecutablePath({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
		});
		if (fs.existsSync(executablePath)) return executablePath;

		logger.warn("Downloading Chromium for puppeteer (first browser use)", {
			buildId,
			platform,
			cacheDir,
		});
		let lastReportedPercent = -1;
		await browsers.install({
			browser: browsers.Browser.CHROME,
			buildId,
			cacheDir,
			platform,
			downloadProgressCallback: ({ downloadedBytes, totalBytes }) => {
				if (totalBytes <= 0) return;
				const pct = Math.floor((downloadedBytes / totalBytes) * 100);
				if (pct >= lastReportedPercent + 10 || downloadedBytes === totalBytes) {
					lastReportedPercent = pct;
					logger.debug(
						`Chromium download: ${pct}% (${Math.round(downloadedBytes / 1_000_000)} / ${Math.round(totalBytes / 1_000_000)} MB)`,
					);
				}
			},
		});
		return executablePath;
	})().catch(err => {
		chromiumExecutablePromise = undefined;
		throw new ToolError(
			`Failed to install Chromium for puppeteer: ${(err as Error).message}. ` +
				"Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium binary, or install one manually.",
		);
	});

	try {
		return await chromiumExecutablePromise;
	} catch (err) {
		if (!preferManagedChromium) throw err;

		const sysChrome = await resolveSystemChromium();
		if (!sysChrome) throw err;
		logger.warn(
			"Chrome for Testing unavailable; falling back to the system Chrome bundle. On macOS this can let the " +
				"headless browser daemon capture your link clicks (#8673). Set PUPPETEER_EXECUTABLE_PATH to a " +
				"dedicated Chromium to avoid this.",
			{ path: sysChrome, error: (err as Error).message },
		);
		return sysChrome;
	}
}

let resolvedChromium: string | null | undefined;

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return false;
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isChromiumExecutable(p: string): Promise<boolean> {
	if (!isExecutableFile(p)) return false;

	if (process.platform !== "linux") return true;
	try {
		const probeTimeoutMs = 3000;
		const proc = Bun.spawn([p, "--version"], {
			stdout: "pipe",
			stderr: "ignore",
			signal: AbortSignal.timeout(probeTimeoutMs),
			killSignal: "SIGKILL",
		});
		const stdout = await Promise.race([
			new Response(proc.stdout).text(),
			Bun.sleep(probeTimeoutMs + 500).then(() => null),
		]);
		if (stdout === null) return false;
		await proc.exited;
		return proc.exitCode === 0 && /Chrom|Edg/i.test(stdout);
	} catch {
		return false;
	}
}

const UNGOOGLED_CHROMIUM_FLATPAK_ID = "io.github.ungoogled_software.ungoogled_chromium";

function systemChromiumCandidates(
	platform: NodeJS.Platform = process.platform,
	home = os.homedir(),
	which: (name: string) => string | null | undefined = $which,
): string[] {
	const candidates: string[] = [];
	switch (platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			for (const name of ["ungoogled-chromium", "ungoogled-chromium-browser"]) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/ungoogled-chromium",
				"/usr/bin/ungoogled-chromium-browser",
				`/var/lib/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`,
				path.join(home, ".local/share/flatpak/exports/bin", UNGOOGLED_CHROMIUM_FLATPAK_ID),
			);
			break;
		}
	}
	return candidates;
}

async function resolveSystemChromium(): Promise<string | undefined> {
	if (resolvedChromium !== undefined) return resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (await isChromiumExecutable(candidate)) {
			resolvedChromium = candidate;
			logger.debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	resolvedChromium = null;
	return undefined;
}

interface LaunchHeadlessOptions {
	headless: boolean;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };

	args?: readonly string[];

	ignoreDefaultArgs?: readonly string[];
}

interface LaunchHeadlessResult {
	browser: Browser;

	userDataDir?: string;
}

function buildHeadlessLaunchArgs(viewport: { width: number; height: number }): string[] {
	const launchArgs = [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-blink-features=AutomationControlled",
		`--window-size=${viewport.width},${viewport.height}`,
	];
	const proxy = process.env.PUPPETEER_PROXY;
	if (proxy) {
		launchArgs.push(`--proxy-server=${proxy}`);

		const bypassLoopback = process.env.PUPPETEER_PROXY_BYPASS_LOOPBACK?.toLowerCase();
		if (bypassLoopback === "true" || bypassLoopback === "1" || bypassLoopback === "yes" || bypassLoopback === "on") {
			launchArgs.push("--proxy-bypass-list=<-loopback>");
		}
	}
	const ignoreCert = process.env.PUPPETEER_PROXY_IGNORE_CERT_ERRORS?.toLowerCase();
	if (ignoreCert === "true" || ignoreCert === "1" || ignoreCert === "yes" || ignoreCert === "on") {
		launchArgs.push("--ignore-certificate-errors");
	}
	return launchArgs;
}

export async function launchHeadlessBrowser(opts: LaunchHeadlessOptions): Promise<LaunchHeadlessResult> {
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const initialViewport = {
		width: vp.width,
		height: vp.height,
		deviceScaleFactor: vp.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	};
	const puppeteer = await loadPuppeteer();
	const launchArgs = buildHeadlessLaunchArgs(initialViewport);
	for (const arg of opts.args ?? []) {
		if (!launchArgs.includes(arg)) launchArgs.push(arg);
	}

	let userDataDir: string | undefined;
	if (!launchArgs.some(arg => arg.startsWith("--user-data-dir"))) {
		userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "proto-chrome-profile-"));
		launchArgs.push(`--user-data-dir=${userDataDir}`);
	}
	try {
		const executablePath = await ensureChromiumExecutable();
		const browser = await puppeteer.launch({
			headless: opts.headless,
			defaultViewport: opts.headless ? initialViewport : null,
			executablePath,
			args: launchArgs,
			ignoreDefaultArgs: [
				...new Set([...stealthIgnoreDefaultArgs(executablePath), ...(opts.ignoreDefaultArgs ?? [])]),
			],
			protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
		});
		return { browser, userDataDir };
	} catch (error) {
		if (userDataDir) await removeUserDataDir(userDataDir);
		throw error;
	}
}

interface SharedBrowserLaunchSpec {
	executablePath: string;
	args: string[];
}

export async function resolveSharedBrowserLaunchSpec(opts: {
	headless: boolean;
	userDataDir: string;
	viewport?: { width: number; height: number };
}): Promise<SharedBrowserLaunchSpec | null> {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) return null;
	const puppeteer = await loadPuppeteer();
	const vp = opts.viewport ?? DEFAULT_VIEWPORT;
	const ignored = new Set(stealthIgnoreDefaultArgs(executablePath));
	const defaults = await puppeteer.defaultArgs({
		headless: opts.headless,
		args: buildHeadlessLaunchArgs(vp),
		userDataDir: opts.userDataDir,
	});
	return {
		executablePath,
		args: [...defaults.filter(arg => !ignored.has(arg)), "--no-startup-window", "--remote-debugging-port=0"],
	};
}

export async function removeUserDataDir(dir: string): Promise<void> {
	try {
		await removeWithRetries(dir);
	} catch (error) {
		logger.warn("Left Chromium profile directory in place after cleanup failure", {
			dir,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function applyViewport(
	page: Page,
	viewport?: { width: number; height: number; deviceScaleFactor?: number },
): Promise<void> {
	if (!viewport) {
		await page.setViewport(DEFAULT_VIEWPORT);
		return;
	}
	await page.setViewport({
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: viewport.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
	});
}

interface PuppeteerCdpClient {
	send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export interface UserAgentOverride {
	userAgent: string;
	platform: string;
	acceptLanguage: string;
	userAgentMetadata: {
		brands: Array<{ brand: string; version: string }>;
		fullVersion: string;
		fullVersionList: Array<{ brand: string; version: string }>;
		platform: string;
		platformVersion: string;
		architecture: string;
		bitness: string;
		model: string;
		mobile: boolean;
	};
}

function resolvePageClient(page: Page): PuppeteerCdpClient | null {
	const pageWithClient = page as Page & {
		_client?: (() => PuppeteerCdpClient) | PuppeteerCdpClient;
	};
	if (!pageWithClient._client) return null;
	return typeof pageWithClient._client === "function" ? pageWithClient._client() : pageWithClient._client;
}

const patchedClients = new WeakSet<object>();

function patchSourceUrl(page: Page): void {
	const client = resolvePageClient(page);
	if (!client) return;
	const clientKey = client as object;
	if (patchedClients.has(clientKey)) return;
	patchedClients.add(clientKey);
	const originalSend = client.send.bind(client);
	client.send = async (method: string, params?: Record<string, unknown>) => {
		const next = async (payload?: Record<string, unknown>) => {
			try {
				return await originalSend(method, payload);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes(
						"Protocol error (Network.getResponseBody): No resource with given identifier found",
					)
				) {
					return undefined;
				}
				throw error;
			}
		};
		if (!method || !params) {
			return next(params);
		}
		const key =
			method === "Runtime.evaluate"
				? "expression"
				: method === "Runtime.callFunctionOn"
					? "functionDeclaration"
					: null;
		if (!key) {
			return next(params);
		}
		const value = params[key];
		if (typeof value !== "string" || !value.includes(PUPPETEER_SOURCE_URL_SUFFIX)) {
			return next(params);
		}
		const patchedParams = { ...params, [key]: value.replace(PUPPETEER_SOURCE_URL_SUFFIX, "") };
		return next(patchedParams);
	};
}

async function resolveMacOsProductVersion(): Promise<string> {
	if (os.platform() !== "darwin") return "";
	try {
		const plist = await Bun.file("/System/Library/CoreServices/SystemVersion.plist").text();
		return plist.match(/<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
	} catch {
		return "";
	}
}

function resolveHostArchitecture(): string {
	if (os.arch() === "arm64") return "arm";
	if (os.arch().includes("64")) return "x86";
	return "";
}

function resolveHostBitness(): string {
	return os.arch().includes("64") ? "64" : "";
}

async function resolveUserAgentOverride(page: Page): Promise<UserAgentOverride> {
	const rawUserAgent = await page.browser().userAgent();
	let userAgent = rawUserAgent.replace("HeadlessChrome/", "Chrome/");
	if (userAgent.includes("Linux") && !userAgent.includes("Android")) {
		userAgent = userAgent.replace(/\(([^)]+)\)/, "(Windows NT 10.0; Win64; x64)");
	}

	const uaVersionMatch = userAgent.match(/Chrome\/([\d|.]+)/);
	const browserVersionMatch = (await page.browser().version()).match(/\/([\d|.]+)/);
	const legacyVersion = uaVersionMatch?.[1] ?? browserVersionMatch?.[1] ?? "0";
	const fullVersion = browserVersionMatch?.[1] ?? legacyVersion;
	const majorVersion = Number.parseInt(legacyVersion.split(".")[0] ?? "0", 10) || 0;
	const isAndroid = userAgent.includes("Android");
	const isMac = userAgent.includes("Mac OS X");
	const isWindows = userAgent.includes("Windows");
	const platform = isMac ? "MacIntel" : isAndroid ? "Android" : userAgent.includes("Linux") ? "Linux" : "Win32";
	const platformFull = isMac ? "macOS" : isAndroid ? "Android" : userAgent.includes("Linux") ? "Linux" : "Windows";
	const platformVersion = isMac
		? await resolveMacOsProductVersion()
		: userAgent.includes("Android ")
			? (userAgent.match(/Android ([^;]+)/)?.[1] ?? "")
			: isWindows
				? (userAgent.match(/Windows NT ([\d.]+)/)?.[1] ?? "")
				: "";
	const architecture = isAndroid ? "" : resolveHostArchitecture();
	const bitness = isAndroid ? "" : resolveHostBitness();
	const model = isAndroid ? (userAgent.match(/Android.*?;\s([^)]+)/)?.[1] ?? "") : "";

	const brandOrders = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	];
	const order = brandOrders[majorVersion % brandOrders.length] ?? brandOrders[0]!;
	const escapedChars = [" ", " ", ";"];
	const greaseyBrand = `${escapedChars[order[0]!]}Not${escapedChars[order[1]!]}A${escapedChars[order[2]!]}Brand`;
	const brands: { brand: string; version: string }[] = [];
	brands[order[0]!] = { brand: greaseyBrand, version: "99" };
	brands[order[1]!] = { brand: "Chromium", version: String(majorVersion) };
	brands[order[2]!] = { brand: "Google Chrome", version: String(majorVersion) };
	const fullVersionList = brands.map(({ brand }) => ({
		brand,
		version: brand === greaseyBrand ? "99.0.0.0" : fullVersion,
	}));

	return {
		userAgent,
		platform,
		acceptLanguage: STEALTH_ACCEPT_LANGUAGE,
		userAgentMetadata: {
			brands,
			fullVersion,
			fullVersionList,
			platform: platformFull,
			platformVersion,
			architecture,
			bitness,
			model,
			mobile: isAndroid,
		},
	};
}

function wrapSession(session: CDPSession): PuppeteerCdpClient {
	return {
		send: async (method, params) => session.send(method as never, params as never),
	};
}

async function sendUserAgentOverride(client: PuppeteerCdpClient, override: UserAgentOverride): Promise<void> {
	try {
		await client.send("Network.enable");
	} catch {}
	try {
		await client.send("Network.setUserAgentOverride", override as unknown as Record<string, unknown>);
	} catch (error) {
		logger.debug("Failed to apply Network user agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		await client.send("Emulation.setUserAgentOverride", override as unknown as Record<string, unknown>);
	} catch (error) {
		logger.debug("Failed to apply Emulation user agent override", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function configureUserAgentTargets(
	browser: Browser,
	state: { browserSession: CDPSession | null; override: UserAgentOverride },
	targetTimeoutMs = USER_AGENT_TARGET_TIMEOUT_MS,
): Promise<void> {
	if (!state.browserSession) {
		state.browserSession = await browser.target().createCDPSession();
		await state.browserSession.send("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: false,
			flatten: true,
		});
		state.browserSession.on(
			"Target.attachedToTarget",
			async (event: { sessionId: string; targetInfo?: { type?: string } }) => {
				if (!targetInfoSupportsUserAgentOverride(event.targetInfo)) return;
				const connection = state.browserSession?.connection();
				const session = connection?.session(event.sessionId);
				if (!session) return;
				await withSoftTimeout(
					sendUserAgentOverride(wrapSession(session), state.override),
					targetTimeoutMs,
					"new target user-agent override",
				);
			},
		);
	}

	const targets = browser.targets().filter(targetSupportsUserAgentOverride);
	await Promise.all(
		targets.map(async target => {
			await withSoftTimeout(
				applyTargetUserAgentOverride(target, state.override),
				targetTimeoutMs,
				"target user-agent override",
			);
		}),
	);
}

function targetSupportsUserAgentOverride(target: Target): boolean {
	return targetInfoSupportsUserAgentOverride({ type: target.type() });
}

function targetInfoSupportsUserAgentOverride(targetInfo: { type?: string } | undefined): boolean {
	return Boolean(targetInfo?.type && USER_AGENT_TARGET_TYPES.has(targetInfo.type));
}

async function applyTargetUserAgentOverride(target: Target, override: UserAgentOverride): Promise<void> {
	const session = await target.createCDPSession();
	try {
		await sendUserAgentOverride(wrapSession(session), override);
	} finally {
		await session.detach().catch(() => undefined);
	}
}

async function withSoftTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | undefined> {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<undefined>(resolve => {
		timeout = setTimeout(() => {
			logger.debug(`Timed out applying ${label}`);
			resolve(undefined);
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			promise.catch(error => {
				logger.debug(`Failed to apply ${label}`, { error: error instanceof Error ? error.message : String(error) });
				return undefined;
			}),
			timeoutPromise,
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

const STEALTH_PATCH_SCRIPTS = [
	stealthTamperingScript,
	stealthActivityScript,
	stealthHairlineScript,
	stealthBotdScript,
	stealthIframeScript,
	stealthWebglScript,
	stealthScreenScript,
	stealthFontsScript,
	stealthAudioScript,
	stealthLocaleScript,
	stealthPluginsScript,
	stealthHardwareScript,
	stealthCodecsScript,
	stealthWorkerScript,
];

function buildStealthInjectionScript(scripts: readonly string[] = STEALTH_PATCH_SCRIPTS): string {
	const joint = scripts
		.map(
			script => `
		try {
			${script};
		} catch (e) {}
	`,
		)
		.join(";\n");

	return `(() => {
				const Page_Function_toString = Function.prototype.toString;
				const Page_FunctionToStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
				const Page_Proxy = Proxy;
				const Page_WeakMap = WeakMap;
				const Page_WeakMap_get = Page_WeakMap.prototype.get;
				const Page_WeakMap_set = Page_WeakMap.prototype.set;
				let iframe = null;
				const container = document.head ?? document.documentElement;
				if (container) {
					iframe = document.createElement("iframe");
					iframe.style.display = "none";
					container.appendChild(iframe);
					if (!iframe.contentWindow) iframe = null;
				}
				try {
					const nativeWindow = iframe ? iframe.contentWindow : window;

					const Function_toString = nativeWindow.Function.prototype.toString;
					const Object_getOwnPropertyDescriptor = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_getOwnPropertyDescriptors = nativeWindow.Object.getOwnPropertyDescriptors;
					const Object_getPrototypeOf = nativeWindow.Object.getPrototypeOf;
					const Object_defineProperty = nativeWindow.Object.defineProperty;
					const Object_getOwnPropertyDescriptorOriginal = nativeWindow.Object.getOwnPropertyDescriptor;
					const Object_create = nativeWindow.Object.create;
					const Object_keys = nativeWindow.Object.keys;
					const Object_getOwnPropertyNames = nativeWindow.Object.getOwnPropertyNames;
					const Object_entries = nativeWindow.Object.entries;
					const Object_setPrototypeOf = nativeWindow.Object.setPrototypeOf;
					const Object_assign = nativeWindow.Object.assign;
					const Window_setTimeout = nativeWindow.setTimeout;
					const Math_random = nativeWindow.Math.random;
					const Math_floor = nativeWindow.Math.floor;
					const Math_max = nativeWindow.Math.max;
					const Math_min = nativeWindow.Math.min;
					const Window_Event = nativeWindow.Event;
					const Promise_resolve = nativeWindow.Promise.resolve.bind(nativeWindow.Promise);
					const Window_Blob = nativeWindow.Blob;
					const Window_Proxy = nativeWindow.Proxy;
					const Reflect_get = nativeWindow.Reflect.get;
					const Reflect_set = nativeWindow.Reflect.set;
					const Reflect_apply = nativeWindow.Reflect.apply;
					const Reflect_construct = nativeWindow.Reflect.construct;
					const Reflect_defineProperty = nativeWindow.Reflect.defineProperty;
					const Reflect_deleteProperty = nativeWindow.Reflect.deleteProperty;
					const Reflect_getOwnPropertyDescriptor = nativeWindow.Reflect.getOwnPropertyDescriptor;
					const Reflect_getPrototypeOf = nativeWindow.Reflect.getPrototypeOf;
					const Reflect_has = nativeWindow.Reflect.has;
					const Reflect_isExtensible = nativeWindow.Reflect.isExtensible;
					const Reflect_ownKeys = nativeWindow.Reflect.ownKeys;
					const Reflect_preventExtensions = nativeWindow.Reflect.preventExtensions;
					const Reflect_setPrototypeOf = nativeWindow.Reflect.setPrototypeOf;
					const Intl_DateTimeFormat = nativeWindow.Intl.DateTimeFormat;
					const Date_constructor = nativeWindow.Date;

					const nativeFunctionSources = new Page_WeakMap();
					const makeNativeString = (name) => "function " + (name || "") + "() { [native code] }";
					const registerNativeSource = (fn, source) => {
						if (typeof fn === "function") Reflect_apply(Page_WeakMap_set, nativeFunctionSources, [fn, source]);
						return fn;
					};
					const patchToString = (fn, name) => registerNativeSource(fn, makeNativeString(name));
					if (${scripts.length > 0 ? "true" : "false"}) {
						const functionToStringProxy = new Page_Proxy(Page_Function_toString, {
							apply(target, thisArg, args) {
								const source = Reflect_apply(Page_WeakMap_get, nativeFunctionSources, [thisArg]);
								if (source) return source;
								return Reflect_apply(target, thisArg, args || []);
							},
							get(target, key, receiver) {
								return Reflect_get(target, key, receiver);
							},
						});
						registerNativeSource(functionToStringProxy, makeNativeString("toString"));
						Object_defineProperty(Function.prototype, "toString", {
							...(Page_FunctionToStringDescriptor || {
								writable: true,
								configurable: true,
								enumerable: false,
							}),
							value: functionToStringProxy,
						});
					}

					${joint}
				} finally {
					if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
				}})();`;
}

async function injectStealthScripts(page: Page): Promise<void> {
	await page.evaluateOnNewDocument(buildStealthInjectionScript());
}

export async function applyStealthPatches(
	browser: Browser,
	page: Page,
	state: { browserSession: CDPSession | null; override: UserAgentOverride | null },
): Promise<void> {
	patchSourceUrl(page);
	if (!state.override) {
		state.override = await resolveUserAgentOverride(page);
	}
	const client = resolvePageClient(page);
	if (client) {
		await sendUserAgentOverride(client, state.override);
	}
	const targetState = { browserSession: state.browserSession, override: state.override };
	await configureUserAgentTargets(browser, targetState);
	state.browserSession = targetState.browserSession;
	await injectStealthScripts(page);
}
