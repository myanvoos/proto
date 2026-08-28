import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, logger } from "@oh-my-pi/pi-utils";
import { credentialString, type DestinationRuntimeConfig, optionString } from "./uploader-runtime";

export type ExposureKind =
	| "cloudflared"
	| "ngrok"
	| "tailscale"
	| "ssh"
	| "direct"
	| "localhost-run"
	| "pinggy"
	| "devtunnel"
	| "zrok"
	| "bore"
	| "named-cloudflared";

export interface ExposureConfig {
	kind: ExposureKind;

	publicBaseUrl?: string;

	bindHost: string;

	sshTarget?: string;

	sshRemotePort?: number;

	options: DestinationRuntimeConfig["options"];

	credentials: DestinationRuntimeConfig["credentials"];
}

export interface ActiveExposure {
	readonly kind: ExposureKind;

	readonly baseUrl: string;

	readonly exited: Promise<void> | null;
	stop(): void;
}

const READY_TIMEOUT_MS = 30_000;
const HEALTH_PATH = "/.well-known/proto-blob-health";
const DEFAULT_HEALTH_ATTEMPTS = 5;
const MAX_HEALTH_ATTEMPTS = 10;
const DEFAULT_HEALTH_BACKOFF_MS = 250;
const MAX_HEALTH_BACKOFF_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const MAX_HEALTH_TIMEOUT_MS = 30_000;

interface ExposureHealthProbeOptions {
	attempts?: number;

	backoffMs?: number;

	timeoutMs?: number;
}

const SSH_READY_GRACE_MS = 1_500;

function parseCloudflaredUrl(line: string): string | null {
	return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0] ?? null;
}

function parseNgrokUrl(line: string): string | null {
	if (!line.includes('"url"')) return null;
	try {
		const parsed = JSON.parse(line) as { msg?: string; url?: string };
		if (typeof parsed.url === "string" && parsed.url.startsWith("https://")) return parsed.url;
	} catch {}
	return null;
}

function parseTailscaleUrl(line: string): string | null {
	const match = /https:\/\/[a-z0-9.-]+\.ts\.net[^\s|]*/.exec(line);
	return match ? match[0].replace(/\/+$/, "") : null;
}

export function parseLocalhostRunUrl(line: string): string | null {
	if (line.includes('"domain"')) {
		try {
			const parsed = JSON.parse(line) as { type?: string; domain?: string };
			if (
				parsed.type === "registered" &&
				typeof parsed.domain === "string" &&
				/^[a-z0-9-]+\.(?:lhr\.life|lhr\.rocks|localhost\.run)$/i.test(parsed.domain)
			) {
				return `https://${parsed.domain.toLowerCase()}`;
			}
		} catch {}
	}
	return /https:\/\/[a-z0-9-]+\.(?:lhr\.life|lhr\.rocks|localhost\.run)/i.exec(line)?.[0] ?? null;
}

export function parsePinggyUrl(line: string): string | null {
	return (
		/https:\/\/[a-z0-9-]+\.(?:a\.pinggy\.link|free\.pinggy\.link|pinggy\.link|pinggy\.online)/i.exec(line)?.[0] ??
		null
	);
}

export function parseDevtunnelUrl(line: string): string | null {
	return /https:\/\/[a-z0-9-]+-\d+\.[a-z0-9.-]+\.devtunnels\.ms/i.exec(line)?.[0] ?? null;
}

export function parseZrokUrl(line: string): string | null {
	return /https:\/\/[a-z0-9-]+\.share\.zrok\.io/i.exec(line)?.[0] ?? null;
}

export function parseBoreUrl(line: string, fallbackHost?: string): string | null {
	const match = /listening at (?:(?<host>[a-z0-9.-]+):)?(?<port>\d+)/i.exec(line);
	const host = match?.groups?.host ?? fallbackHost;
	const port = match?.groups?.port;
	return host && port ? `http://${host}:${port}` : null;
}

function requireBinary(name: string): string {
	const path = $which(name);
	if (!path) {
		throw new Error(`imageUrls exposure "${name}" requires the ${name} binary on PATH`);
	}
	return path;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(0, Math.floor(value)));
}

export async function probeExposureHealth(
	baseUrl: string,
	fetchFn: typeof globalThis.fetch = globalThis.fetch,
	options: ExposureHealthProbeOptions = {},
): Promise<void> {
	const attempts = Math.max(1, boundedInteger(options.attempts, DEFAULT_HEALTH_ATTEMPTS, MAX_HEALTH_ATTEMPTS));
	const backoffMs = boundedInteger(options.backoffMs, DEFAULT_HEALTH_BACKOFF_MS, MAX_HEALTH_BACKOFF_MS);
	const timeoutMs = Math.max(1, boundedInteger(options.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, MAX_HEALTH_TIMEOUT_MS));
	const healthUrl = new URL(HEALTH_PATH, `${normalizeBaseUrl(baseUrl)}/`);
	const destination = healthUrl.origin;
	let finalStatus = "request failed";

	for (let attempt = 0; attempt < attempts; attempt++) {
		healthUrl.searchParams.set("nonce", `${Date.now().toString(36)}-${attempt.toString(36)}`);
		try {
			const response = await fetchFn(healthUrl, {
				cache: "no-store",
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (response.status === 204) return;
			finalStatus = `HTTP ${response.status}`;
			try {
				await response.body?.cancel();
			} catch {}
		} catch (error) {
			finalStatus = error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "request failed";
		}
		if (attempt + 1 < attempts && backoffMs > 0) await Bun.sleep(backoffMs);
	}

	throw new Error(`Exposure health probe for ${destination} failed with status ${finalStatus}`);
}

function killTunnelProcess(proc: Bun.Subprocess): void {
	proc.kill();
	const timer = setTimeout(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	}, 2_000);
	timer.unref();
}

async function spawnUrlTunnel(
	argv: string[],
	extract: (line: string) => string | null,
	readyPattern?: RegExp,
): Promise<{ proc: Bun.Subprocess; baseUrl: string }> {
	const logPath = path.join(os.tmpdir(), `proto-blob-tunnel-${Date.now().toString(36)}-${process.pid}.log`);
	const fd = fs.openSync(logPath, "w");
	let proc: Bun.Subprocess;
	try {
		proc = Bun.spawn(argv, { env: process.env, stdin: "ignore", stdout: fd, stderr: fd });
	} finally {
		fs.closeSync(fd);
	}

	const deadline = Date.now() + READY_TIMEOUT_MS;
	let scanned = 0;
	let baseUrl: string | undefined;
	while (Date.now() < deadline) {
		let text = "";
		try {
			text = await Bun.file(logPath).text();
		} catch {}
		if (text.length > scanned) {
			if (baseUrl === undefined) {
				for (const line of text.slice(scanned).split("\n")) {
					const url = extract(line);
					if (url) {
						baseUrl = normalizeBaseUrl(url);
						break;
					}
				}
				scanned = text.lastIndexOf("\n") + 1;
			}

			if (baseUrl !== undefined && (!readyPattern || readyPattern.test(text))) {
				return { proc, baseUrl };
			}
		}
		if (proc.exitCode !== null) {
			throw new Error(`${argv[0]} exited with code ${proc.exitCode} before reporting a tunnel URL`);
		}
		await Bun.sleep(150);
	}
	killTunnelProcess(proc);
	throw new Error(`${argv[0]} did not report a tunnel URL within ${READY_TIMEOUT_MS / 1000}s`);
}

function processExposure(kind: ExposureKind, baseUrl: string, proc: Bun.Subprocess): ActiveExposure {
	proc.unref();
	return {
		kind,
		baseUrl,
		exited: proc.exited.then(() => undefined),
		stop: () => killTunnelProcess(proc),
	};
}

function restartingPinggyExposure(baseUrl: string, argv: string[], initialProc: Bun.Subprocess): ActiveExposure {
	let proc = initialProc;
	let stopping = false;
	proc.unref();
	const exited = (async () => {
		while (true) {
			await proc.exited;
			if (stopping) return;
			try {
				const restarted = await spawnUrlTunnel(argv, parsePinggyUrl);
				if (stopping) {
					killTunnelProcess(restarted.proc);
					await restarted.proc.exited;
					return;
				}
				proc = restarted.proc;
				proc.unref();
			} catch {
				logger.warn("blob-broker: authenticated Pinggy tunnel failed to reconnect");
				return;
			}
		}
	})();
	return {
		kind: "pinggy",
		baseUrl,
		exited,
		stop: () => {
			stopping = true;
			killTunnelProcess(proc);
		},
	};
}

export async function startExposure(config: ExposureConfig, port: number): Promise<ActiveExposure> {
	switch (config.kind) {
		case "direct": {
			const baseUrl = normalizeBaseUrl(config.publicBaseUrl ?? `http://${config.bindHost}:${port}`);
			return { kind: "direct", baseUrl, exited: null, stop: () => {} };
		}
		case "cloudflared": {
			const binary = requireBinary("cloudflared");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
				parseCloudflaredUrl,
				/Registered tunnel connection/,
			);
			return processExposure("cloudflared", baseUrl, proc);
		}
		case "ngrok": {
			const binary = requireBinary("ngrok");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "http", String(port), "--log", "stdout", "--log-format", "json"],
				parseNgrokUrl,
			);
			return processExposure("ngrok", baseUrl, proc);
		}
		case "tailscale": {
			const binary = requireBinary("tailscale");
			const { proc, baseUrl } = await spawnUrlTunnel([binary, "funnel", String(port)], parseTailscaleUrl);
			return processExposure("tailscale", baseUrl, proc);
		}
		case "localhost-run": {
			const binary = requireBinary("ssh");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[
					binary,
					"-o",
					"BatchMode=yes",
					"-o",
					"StrictHostKeyChecking=accept-new",
					"-o",
					"ServerAliveInterval=30",
					"-o",
					"ServerAliveCountMax=3",
					"-o",
					"ExitOnForwardFailure=yes",
					"-R",
					`80:127.0.0.1:${port}`,
					"nokey@localhost.run",
					"--",
					"--output",
					"json",
				],
				parseLocalhostRunUrl,
			);
			return processExposure("localhost-run", baseUrl, proc);
		}
		case "pinggy": {
			const binary = requireBinary("ssh");
			const token = credentialString(config, "token");
			const argv = token
				? [
						binary,
						"-p",
						"443",
						"-o",
						"BatchMode=yes",
						"-o",
						"StrictHostKeyChecking=accept-new",
						"-R",
						`0:127.0.0.1:${port}`,
						`${token}@pro.pinggy.io`,
					]
				: [
						binary,
						"-p",
						"443",
						"-o",
						"BatchMode=yes",
						"-o",
						"StrictHostKeyChecking=accept-new",
						"-o",
						"ServerAliveInterval=30",
						"-o",
						"ServerAliveCountMax=3",
						"-o",
						"ExitOnForwardFailure=yes",
						"-R",
						`0:127.0.0.1:${port}`,
						"free.pinggy.io",
					];
			const { proc, baseUrl } = await spawnUrlTunnel(argv, parsePinggyUrl);
			if (token && config.publicBaseUrl) {
				return restartingPinggyExposure(normalizeBaseUrl(config.publicBaseUrl), argv, proc);
			}
			return processExposure("pinggy", baseUrl, proc);
		}
		case "devtunnel": {
			const binary = requireBinary("devtunnel");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "host", "-p", String(port), "--allow-anonymous", "--protocol", "http"],
				parseDevtunnelUrl,
			);
			return processExposure("devtunnel", baseUrl, proc);
		}
		case "zrok": {
			const binary = requireBinary("zrok");
			const { proc, baseUrl } = await spawnUrlTunnel(
				[binary, "share", "public", `http://127.0.0.1:${port}`, "--headless", "--backend-mode", "proxy"],
				parseZrokUrl,
			);
			return processExposure("zrok", baseUrl, proc);
		}
		case "bore": {
			const binary = requireBinary("bore");
			const server = optionString(config, "server", "bore.pub");
			if (!server) throw new Error('imageUrls exposure "bore" requires options.server');
			const secret = credentialString(config, "secret");
			const argv = [binary, "local", String(port), "--to", server];
			if (secret) argv.push("--secret", secret);
			const { proc, baseUrl } = await spawnUrlTunnel(argv, line => parseBoreUrl(line, server));
			return processExposure("bore", baseUrl, proc);
		}
		case "named-cloudflared": {
			if (!config.publicBaseUrl) {
				throw new Error('imageUrls exposure "named-cloudflared" requires imageUrls.publicBaseUrl');
			}
			const binary = requireBinary("cloudflared");
			const token = credentialString(config, "tunnelToken");
			let argv: string[];
			if (token) {
				argv = [binary, "tunnel", "--no-autoupdate", "run", "--token", token];
			} else {
				const configFile = optionString(config, "configFile");
				const tunnelName = optionString(config, "tunnelName");
				if (!configFile || !tunnelName) {
					throw new Error(
						'imageUrls exposure "named-cloudflared" requires credentials.tunnelToken or options.configFile and options.tunnelName',
					);
				}
				argv = [binary, "tunnel", "--no-autoupdate", "--config", configFile, "run", tunnelName];
			}
			const baseUrl = normalizeBaseUrl(config.publicBaseUrl);
			const { proc } = await spawnUrlTunnel(
				argv,
				() => baseUrl,
				/Registered tunnel connection|Connection [a-z0-9-]+ registered/i,
			);
			return processExposure("named-cloudflared", baseUrl, proc);
		}
		case "ssh": {
			if (!config.publicBaseUrl) throw new Error('imageUrls exposure "ssh" requires imageUrls.publicBaseUrl');
			if (!config.sshTarget) throw new Error('imageUrls exposure "ssh" requires imageUrls.sshTarget');
			const binary = requireBinary("ssh");
			const remotePort = config.sshRemotePort ?? 8787;
			const proc = Bun.spawn(
				[
					binary,
					"-o",
					"BatchMode=yes",
					"-o",
					"ExitOnForwardFailure=yes",
					"-N",
					"-R",
					`${remotePort}:127.0.0.1:${port}`,
					config.sshTarget,
				],
				{ env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			const early = await Promise.race([
				proc.exited.then(code => code),
				Bun.sleep(SSH_READY_GRACE_MS).then(() => null),
			]);
			if (early !== null) {
				throw new Error(`ssh reverse forward to ${config.sshTarget} exited with code ${early}`);
			}
			logger.debug("blob-broker: ssh reverse forward established", {
				target: config.sshTarget,
				remotePort,
				localPort: port,
			});
			return processExposure("ssh", normalizeBaseUrl(config.publicBaseUrl), proc);
		}
	}
}
