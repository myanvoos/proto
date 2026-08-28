import * as os from "node:os";
import * as AIError from "../../error";
import templateHtml from "./oauth.html" with { type: "text" };
import type { OAuthController, OAuthCredentials } from "./types";

const DEFAULT_TIMEOUT = 300_000;
const DEFAULT_HOSTNAME = "localhost";
const CALLBACK_PATH = "/callback";
const IPV4_LOOPBACK = "127.0.0.1";
const IPV6_LOOPBACK = "::1";

const IPV6_COMPANION_ATTEMPTS = 4;

const LAUNCH_PATH = "/launch";

export type CallbackResult = { code: string; state: string };

interface CallbackServer {
	readonly port: Bun.Server<unknown>["port"];
	stop: Bun.Server<unknown>["stop"];
}

function isAddressInUse(error: unknown): boolean {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	if (typeof code === "string") return code === "EADDRINUSE";
	return error instanceof Error && /EADDRINUSE|in use/i.test(error.message);
}

function ipv6LoopbackAvailable(): boolean {
	const interfaces = os.networkInterfaces();
	for (const name in interfaces) {
		const addresses = interfaces[name];
		if (!addresses) continue;
		for (const address of addresses) {
			if (address.internal && address.family === "IPv6") return true;
		}
	}
	return false;
}

export interface OAuthCallbackFlowOptions {
	preferredPort: number;
	callbackPath?: string;
	callbackHostname?: string;

	redirectUri?: string;

	allowPortFallback?: boolean;

	manualInputOnly?: boolean;
}

export abstract class OAuthCallbackFlow {
	ctrl: OAuthController;
	preferredPort: number;
	callbackPath: string;
	callbackHostname: string;
	redirectUri?: string;
	allowPortFallback: boolean;
	#manualInputOnly: boolean;
	#callbackResolve?: (result: CallbackResult) => void;
	#callbackReject?: (error: Error) => void;

	#pendingAuthUrl?: string;

	constructor(
		ctrl: OAuthController,
		preferredPortOrOptions: number | OAuthCallbackFlowOptions,
		callbackPath: string = CALLBACK_PATH,
	) {
		this.ctrl = ctrl;
		if (typeof preferredPortOrOptions === "number") {
			this.preferredPort = preferredPortOrOptions;
			this.callbackPath = callbackPath;
			this.callbackHostname = DEFAULT_HOSTNAME;
			this.allowPortFallback = true;
			this.#manualInputOnly = false;
			return;
		}

		this.preferredPort = preferredPortOrOptions.preferredPort;
		this.callbackPath = preferredPortOrOptions.callbackPath ?? CALLBACK_PATH;
		this.callbackHostname = preferredPortOrOptions.callbackHostname ?? DEFAULT_HOSTNAME;
		this.redirectUri = preferredPortOrOptions.redirectUri;
		this.allowPortFallback = preferredPortOrOptions.allowPortFallback ?? true;
		this.#manualInputOnly = preferredPortOrOptions.manualInputOnly ?? false;
	}

	abstract generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }>;

	abstract exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials>;

	generateState(): string {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes)
			.map(value => value.toString(16).padStart(2, "0"))
			.join("");
	}

	#loginCancelledError(): AIError.LoginCancelledError {
		return new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal?.reason}`);
	}

	#throwIfCancelled(): void {
		if (this.ctrl.signal?.aborted) throw this.#loginCancelledError();
	}

	async login(): Promise<OAuthCredentials> {
		const state = this.generateState();
		this.#throwIfCancelled();

		const { server, redirectUri, launchUrl } = this.#manualInputOnly
			? { server: undefined, redirectUri: this.#buildRedirectUri(), launchUrl: undefined }
			: await this.#startCallbackServer(state);

		try {
			this.#throwIfCancelled();

			const { url: authUrl, instructions } = await this.generateAuthUrl(state, redirectUri);
			this.#throwIfCancelled();

			this.#pendingAuthUrl = authUrl;

			this.ctrl.onAuth?.({ url: authUrl, launchUrl, instructions });
			this.ctrl.onProgress?.(
				this.#manualInputOnly
					? "Waiting for pasted authorization code..."
					: "Waiting for browser authentication...",
			);

			const { code } = await this.#waitForCallback(state);
			this.#throwIfCancelled();

			this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

			return await this.exchangeToken(code, state, redirectUri);
		} finally {
			this.#pendingAuthUrl = undefined;
			server?.stop();
		}
	}

	#buildRedirectUri(): string {
		return this.redirectUri ?? `http://${this.callbackHostname}:${this.preferredPort}${this.callbackPath}`;
	}

	async #startCallbackServer(
		expectedState: string,
	): Promise<{ server: CallbackServer; redirectUri: string; launchUrl: string | undefined }> {
		try {
			const server = this.#createServer(this.preferredPort, expectedState);

			const actualPort = this.#resolveServerPort(server);
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			if (this.redirectUri) {
				return { server, redirectUri: this.redirectUri, launchUrl };
			}
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			return { server, redirectUri, launchUrl };
		} catch (cause) {
			if (this.redirectUri) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use, but oauth.redirectUri (${this.redirectUri}) requires this exact port. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or change oauth.redirectUri to point at an available port.`,
					{ cause },
				);
			}
			if (!this.allowPortFallback) {
				throw new AIError.ConfigurationError(
					`OAuth callback port ${this.preferredPort} is in use. The OAuth provider validates redirect URIs against its registered callback, so falling back to a random port would be rejected. Free port ${this.preferredPort} (e.g. stop the process bound to it) and retry, or set oauth.callbackPort/oauth.redirectUri to a port the provider has registered.`,
					{ cause },
				);
			}
			const server = this.#createServer(0, expectedState);
			const actualPort = this.#resolveServerPort(server);
			const redirectUri = `http://${this.callbackHostname}:${actualPort}${this.callbackPath}`;
			const launchUrl = this.#launchUrlIfSafe(actualPort);
			this.ctrl.onProgress?.(`Preferred port ${this.preferredPort} unavailable, using port ${actualPort}`);
			return { server, redirectUri, launchUrl };
		}
	}

	#resolveServerPort(server: CallbackServer): number {
		const port = server.port;
		if (typeof port !== "number") {
			throw new AIError.ConfigurationError(
				"OAuth callback server bound to a non-TCP endpoint; expected a numeric port. Check `oauth.callbackPort`/`oauth.redirectUri`.",
			);
		}
		return port;
	}

	#launchUrlIfSafe(port: number): string | undefined {
		if (this.callbackPath === LAUNCH_PATH) return undefined;
		if (this.redirectUri) {
			try {
				const parsed = new URL(this.redirectUri);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
				if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
					return undefined;
				}
				if (parsed.pathname === LAUNCH_PATH) return undefined;
			} catch {
				return undefined;
			}
		}
		return `http://${this.callbackHostname}:${port}${LAUNCH_PATH}`;
	}

	#createServer(port: number, expectedState: string): CallbackServer {
		if (this.callbackHostname !== DEFAULT_HOSTNAME) {
			return this.#serve(this.callbackHostname, port, expectedState);
		}

		const dualStack = ipv6LoopbackAvailable();
		for (let attempt = 0; ; attempt++) {
			const primary = this.#serve(IPV4_LOOPBACK, port, expectedState);
			const boundPort = primary.port;

			if (typeof boundPort !== "number") return primary;
			if (!dualStack) return primary;
			let companion: Bun.Server<unknown>;
			try {
				companion = this.#serve(IPV6_LOOPBACK, boundPort, expectedState);
			} catch (cause) {
				if (!isAddressInUse(cause)) return primary;
				void primary.stop(true);

				if (port !== 0 || attempt >= IPV6_COMPANION_ATTEMPTS) throw cause;
				continue;
			}

			return {
				get port() {
					return primary.port;
				},
				stop: (closeActiveConnections?: boolean) => {
					void companion.stop(closeActiveConnections);
					return primary.stop(closeActiveConnections);
				},
			};
		}
	}

	#serve(hostname: string, port: number, expectedState: string): Bun.Server<unknown> {
		return Bun.serve({
			hostname,
			port,
			reusePort: false,
			fetch: req => this.#handleCallback(req, expectedState),
		});
	}

	#handleCallback(req: Request, expectedState: string): Response {
		const url = new URL(req.url);

		if (url.pathname !== this.callbackPath) {
			if (url.pathname === LAUNCH_PATH) {
				const pending = this.#pendingAuthUrl;
				if (!pending) {
					return new Response("OAuth launch URL is no longer active", { status: 503 });
				}
				return Response.redirect(pending, 302);
			}
			return new Response("Not Found", { status: 404 });
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") || "";
		const error = url.searchParams.get("error") || "";
		const errorDescription = url.searchParams.get("error_description") || error;

		type OkState = { ok: true; code: string; state: string };
		type ErrorState = { ok?: false; error?: string };
		let resultState: OkState | ErrorState;

		if (error) {
			resultState = { ok: false, error: `Authorization failed: ${errorDescription}` };
		} else if (!code) {
			resultState = { ok: false, error: "Missing authorization code" };
		} else if (expectedState && state !== expectedState) {
			resultState = { ok: false, error: "State mismatch - possible CSRF attack" };
		} else {
			resultState = { ok: true, code, state };
		}

		if (resultState.ok) {
			const resolve = this.#callbackResolve;
			queueMicrotask(() => {
				resolve?.({ code: resultState.code, state: resultState.state });
			});
		} else if (error && (!expectedState || state === expectedState)) {
			const reject = this.#callbackReject;
			const message = resultState.error ?? `Authorization failed: ${errorDescription}`;
			queueMicrotask(() => {
				reject?.(new AIError.OAuthError(message, { kind: "device-auth" }));
			});
		}

		return new Response(
			(templateHtml as unknown as string).replaceAll("__OAUTH_STATE__", JSON.stringify(resultState)),
			{
				status: resultState.ok ? 200 : 500,
				headers: { "Content-Type": "text/html" },
			},
		);
	}

	#waitForCallback(expectedState: string): Promise<CallbackResult> {
		const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT);
		const signal = this.ctrl.signal ? AbortSignal.any([this.ctrl.signal, timeoutSignal]) : timeoutSignal;
		if (signal.aborted) return Promise.reject(this.#loginCancelledError());

		const callback = Promise.withResolvers<CallbackResult>();
		this.#callbackResolve = callback.resolve;
		this.#callbackReject = callback.reject;

		signal.addEventListener("abort", () => {
			this.#callbackResolve = undefined;
			this.#callbackReject = undefined;
			callback.reject(new AIError.LoginCancelledError(`OAuth callback cancelled: ${signal.reason}`));
		});
		const callbackPromise = callback.promise;

		if (this.ctrl.onManualCodeInput) {
			const requestManualInput = this.ctrl.onManualCodeInput;
			const manualPromise = (async (): Promise<CallbackResult> => {
				while (true) {
					const result = await Promise.race([
						callbackPromise,
						requestManualInput()
							.then((input): CallbackResult | null => {
								const parsed = parseCallbackInput(input);
								if (!parsed.code) return null;
								if (expectedState && parsed.state && parsed.state !== expectedState) return null;
								return { code: parsed.code, state: parsed.state ?? "" };
							})
							.catch((): CallbackResult | null => null),
					]);
					if (result) return result;
				}
			})();

			return Promise.race([callbackPromise, manualPromise]);
		}

		return callbackPromise;
	}
}

export function parseCallbackInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	const [code, state] = value.split("#", 2);
	return { code, state };
}
