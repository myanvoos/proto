import * as net from "node:net";
import * as tls from "node:tls";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { AbortError } from "../error/abort";
import { StreamTimeoutError, ValidationError } from "../error/validation";
import type { FetchImpl } from "../types";

function proxyLogTarget(proxyUrl: string): string {
	try {
		return new URL(proxyUrl).host;
	} catch {
		return "<unparseable>";
	}
}

export function isLocalOrMetadataHost(host: string): boolean {
	const lowerHost = host.toLowerCase();

	if (lowerHost === "localhost" || lowerHost.endsWith(".localhost") || lowerHost === "metadata.google.internal") {
		return true;
	}

	const ip = lowerHost.replace(/^\[|\]$/g, "");

	const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
	if (v4) {
		const a = Number(v4[1]);
		const b = Number(v4[2]);
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		return false;
	}

	if (ip === "::1" || ip === "::") return true;
	if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
	if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

	return false;
}

export function shouldBypassProxy(urlObj: URL): boolean {
	if (isLocalOrMetadataHost(urlObj.hostname)) {
		return true;
	}

	const noProxyVal = Bun.env.NO_PROXY || Bun.env.no_proxy;
	if (!noProxyVal) {
		return false;
	}

	const rules = noProxyVal
		.split(/[,\s]+/)
		.map(r => r.trim())
		.filter(Boolean);
	const targetHost = urlObj.hostname.toLowerCase();
	const targetPort = urlObj.port || (urlObj.protocol === "https:" || urlObj.protocol === "wss:" ? "443" : "80");

	for (const rule of rules) {
		if (rule === "*") {
			return true;
		}

		let ruleHost = rule.toLowerCase();
		let rulePort: string | undefined;

		if (ruleHost.includes("]:")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		} else if (!ruleHost.includes("]") && ruleHost.includes(":")) {
			const lastColon = ruleHost.lastIndexOf(":");
			rulePort = ruleHost.slice(lastColon + 1);
			ruleHost = ruleHost.slice(0, lastColon);
		}

		ruleHost = ruleHost.replace(/^\[|\]$/g, "");

		if (rulePort && rulePort !== targetPort) {
			continue;
		}

		if (ruleHost.startsWith(".")) {
			const suffix = ruleHost;
			const cleanRule = ruleHost.slice(1);
			if (targetHost === cleanRule || targetHost.endsWith(suffix)) {
				return true;
			}
		} else {
			if (targetHost === ruleHost || targetHost.endsWith(`.${ruleHost}`)) {
				return true;
			}
		}
	}

	return false;
}

const proxyCache = new Map<string, string | undefined>();

export function __resetProxyCache(): void {
	proxyCache.clear();
}

export function getProxyForProvider(provider: string): string | undefined {
	if (proxyCache.has(provider)) {
		return proxyCache.get(provider);
	}

	const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const envKey = `PI_PROXY_${normalized}`;
	const value = Bun.env[envKey] || Bun.env.PI_PROXY;
	proxyCache.set(provider, value);

	logger.debug("provider proxy resolved", {
		provider,
		source: Bun.env[envKey] ? envKey : value ? "PI_PROXY" : "none",
		proxy: value ? proxyLogTarget(value) : undefined,
	});
	return value;
}

export function getProxyForUrl(provider: string, url: URL): string | undefined {
	if (shouldBypassProxy(url)) return undefined;
	const protocolProxy =
		url.protocol === "https:" || url.protocol === "wss:"
			? Bun.env.HTTPS_PROXY || Bun.env.https_proxy
			: Bun.env.HTTP_PROXY || Bun.env.http_proxy;
	return getProxyForProvider(provider) || protocolProxy || Bun.env.ALL_PROXY || Bun.env.all_proxy || undefined;
}

function wrapFetchWithProxyUrl(fetchImpl: FetchImpl, proxyUrl: string | undefined): FetchImpl {
	if (!proxyUrl) {
		return fetchImpl;
	}

	const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		if ((init as { proxy?: unknown } | undefined)?.proxy) {
			return fetchImpl(input, init);
		}
		const urlStr = input instanceof Request ? input.url : input.toString();
		let urlObj: URL;
		try {
			urlObj = new URL(urlStr);
		} catch {
			return fetchImpl(input, init);
		}

		if (shouldBypassProxy(urlObj)) {
			if (!isLocalOrMetadataHost(urlObj.hostname)) {
				logger.debug("proxy bypassed by NO_PROXY", {
					host: urlObj.host,
					noProxy: Bun.env.NO_PROXY || Bun.env.no_proxy,
				});
			}
			return fetchImpl(input, init);
		}

		const mergedInit = { ...(init ?? {}), proxy: proxyUrl };
		return fetchImpl(input, mergedInit);
	};

	if (fetchImpl.preconnect) {
		wrapped.preconnect = fetchImpl.preconnect;
	}
	return wrapped;
}

export function wrapFetchForProxy(fetchImpl: FetchImpl, provider: string): FetchImpl {
	return wrapFetchWithProxyUrl(fetchImpl, getProxyForProvider(provider));
}

let globalProxyFetchInstalled = false;

export function __resetGlobalProxyFetch(): void {
	globalProxyFetchInstalled = false;
}

export function installGlobalProxyFetch(): void {
	if (globalProxyFetchInstalled) return;
	const proxyUrl = Bun.env.PI_PROXY?.trim();

	const env = {
		PI_PROXY: proxyUrl ? proxyLogTarget(proxyUrl) : undefined,
		PI_PROXY_ANTHROPIC: Bun.env.PI_PROXY_ANTHROPIC ? proxyLogTarget(Bun.env.PI_PROXY_ANTHROPIC) : undefined,
		HTTPS_PROXY: Bun.env.HTTPS_PROXY || Bun.env.https_proxy ? "set" : undefined,
		ALL_PROXY: Bun.env.ALL_PROXY || Bun.env.all_proxy ? "set" : undefined,
		NO_PROXY: Bun.env.NO_PROXY || Bun.env.no_proxy,
	};
	if (!proxyUrl) {
		logger.debug("global proxy fetch not installed", {
			reason: "PI_PROXY unset",
			env,
		});
		return;
	}
	globalProxyFetchInstalled = true;
	globalThis.fetch = wrapFetchWithProxyUrl(globalThis.fetch, proxyUrl) as typeof globalThis.fetch;
	logger.debug("global proxy fetch installed", {
		proxy: proxyLogTarget(proxyUrl),
		env,
	});
}

export interface ConnectProxiedSocketOptions {
	signal?: AbortSignal;

	timeoutMs?: number;

	tls?: tls.ConnectionOptions;
}

export async function connectProxiedSocket(
	proxyUrlStr: string,
	targetUrlStr: string,
	options?: ConnectProxiedSocketOptions,
): Promise<tls.TLSSocket> {
	if (options?.signal?.aborted) {
		throw new AbortError("Proxy tunnel aborted");
	}

	const proxyUrl = new URL(proxyUrlStr);
	const targetUrl = new URL(targetUrlStr);

	const useProxySsl = proxyUrl.protocol === "https:";
	const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : useProxySsl ? 443 : 80;
	const proxyHost = proxyUrl.hostname;

	const targetPort = targetUrl.port ? parseInt(targetUrl.port, 10) : 443;
	const targetHost = targetUrl.hostname;

	const { promise, resolve, reject } = Promise.withResolvers<tls.TLSSocket>();

	const readyEvent = useProxySsl ? "secureConnect" : "connect";
	let rawSocket: net.Socket | undefined;
	let tunnelSocket: tls.TLSSocket | undefined;
	let timeout: NodeJS.Timeout | undefined;
	let responseData = "";
	let settled = false;

	const cleanup = (): void => {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		options?.signal?.removeEventListener("abort", onAbort);
		rawSocket?.off("error", onRawError);
		rawSocket?.off(readyEvent, onProxyReady);
		rawSocket?.off("data", onProxyData);
		tunnelSocket?.off("secureConnect", onTunnelReady);
		tunnelSocket?.off("error", onTunnelError);
	};
	const destroyInProgress = (): void => {
		tunnelSocket?.destroy();
		rawSocket?.destroy();
	};
	const rejectOnce = (error: Error): void => {
		if (settled) return;
		settled = true;
		cleanup();
		destroyInProgress();
		logger.debug("proxy tunnel failed", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			error: String(error),
			code: "code" in error ? String(error.code) : undefined,
		});
		reject(error);
	};
	const resolveOnce = (socket: tls.TLSSocket): void => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(socket);
	};
	const onAbort = (): void => rejectOnce(new AbortError("Proxy tunnel aborted"));
	const onRawError = (error: Error): void => rejectOnce(error);
	const onTunnelError = (error: Error): void => rejectOnce(error);
	const onTunnelReady = (): void => {
		if (!tunnelSocket) return;
		logger.debug("proxy tunnel established", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket?.remoteAddress ?? "?"}:${rawSocket?.remotePort ?? "?"}`,
			localPort: rawSocket?.localPort,
			alpn: tunnelSocket.alpnProtocol,
			authorized: tunnelSocket.authorized,
		});
		resolveOnce(tunnelSocket);
	};
	const onProxyData = (chunk: Buffer): void => {
		if (!rawSocket) return;
		responseData += chunk.toString("binary");
		if (!responseData.includes("\r\n\r\n")) return;

		rawSocket.off("data", onProxyData);
		rawSocket.off("error", onRawError);

		const firstLine = responseData.split("\r\n")[0];
		logger.debug("proxy tunnel CONNECT reply", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			reply: firstLine,
		});
		if (!firstLine.includes(" 200 ")) {
			rejectOnce(new ValidationError(`Proxy tunnel failed: ${firstLine}`));
			return;
		}

		const tlsOptions = options?.tls;
		tunnelSocket = tls.connect({
			...tlsOptions,
			socket: rawSocket,
			servername: tlsOptions?.servername ?? targetHost,
			ALPNProtocols: tlsOptions?.ALPNProtocols ?? ["h2"],
		});
		tunnelSocket.once("secureConnect", onTunnelReady);
		tunnelSocket.once("error", onTunnelError);
	};
	const onProxyReady = (): void => {
		if (!rawSocket) return;
		let connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` + `Host: ${targetHost}:${targetPort}\r\n`;

		if (proxyUrl.username || proxyUrl.password) {
			const creds = Buffer.from(
				`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
			).toString("base64");
			connectReq += `Proxy-Authorization: Basic ${creds}\r\n`;
		}
		connectReq += "\r\n";

		rawSocket.write(connectReq);
		rawSocket.on("data", onProxyData);
		logger.debug("proxy tunnel CONNECT sent", {
			proxy: `${proxyHost}:${proxyPort}`,
			target: `${targetHost}:${targetPort}`,
			peer: `${rawSocket.remoteAddress ?? "?"}:${rawSocket.remotePort ?? "?"}`,
		});
	};

	options?.signal?.addEventListener("abort", onAbort, { once: true });
	if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		const timeoutMs = Math.trunc(options.timeoutMs);
		timeout = setTimeout(() => {
			rejectOnce(new StreamTimeoutError(`Proxy tunnel timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timeout.unref?.();
	}

	rawSocket = useProxySsl
		? tls.connect({
				host: proxyHost,
				port: proxyPort,
			})
		: net.connect({
				host: proxyHost,
				port: proxyPort,
			});
	rawSocket.once("error", onRawError);
	rawSocket.once(readyEvent, onProxyReady);

	return promise;
}
