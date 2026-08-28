import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { daemonClientForProject } from "../../launch/client";
import { describeQuietly, stopQuietly, waitReady } from "../../launch/ensure";
import { daemonRuntimeDir } from "../../launch/paths";
import type { DaemonSnapshot } from "../../launch/protocol";
import { throwIfAborted } from "../tool-errors";
import { probeCdpStatus } from "./attach";
import { resolveSharedBrowserLaunchSpec } from "./launch";

const READY_LOG_PATTERN = String.raw`DevTools listening on ws://\S+`;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 1_500;

const ENSURE_ATTEMPTS = 3;

interface SharedBrowserEndpoint {
	wsEndpoint: string;
	daemonName: string;

	projectDir: string;
}

function sharedBrowserDaemonName(headless: boolean): string {
	return headless ? "proto.browser.headless" : "proto.browser.headed";
}

function wsEndpointOf(snapshot: DaemonSnapshot | undefined): string | undefined {
	return snapshot?.readyMatch?.match(/ws:\/\/\S+/)?.[0];
}

async function probeEndpoint(wsEndpoint: string): Promise<boolean> {
	let host: string;
	try {
		host = new URL(wsEndpoint).host;
	} catch {
		return false;
	}
	const status = await probeCdpStatus(`http://${host}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
	return status !== null && status >= 200 && status < 300;
}

export async function ensureSharedBrowser(opts: {
	projectDir: string;
	headless: boolean;
	viewport?: { width: number; height: number };
	signal?: AbortSignal;
}): Promise<SharedBrowserEndpoint | null> {
	const client = await daemonClientForProject(opts.projectDir);
	const name = sharedBrowserDaemonName(opts.headless);

	const userDataDir = path.join(daemonRuntimeDir(client.projectDir), `${name}.profile`);
	const launch = await resolveSharedBrowserLaunchSpec({
		headless: opts.headless,
		userDataDir,
		viewport: opts.viewport,
	});
	if (!launch) return null;
	await fs.mkdir(userDataDir, { recursive: true });
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		throwIfAborted(opts.signal);
		const existing = await describeQuietly(client, name, "Shared browser", opts.signal);
		if (existing && existing.state !== "exited" && existing.state !== "failed") {
			const settled =
				existing.readyAt !== undefined ? existing : await waitReady(client, name, "Shared browser", opts.signal);
			const wsEndpoint = wsEndpointOf(settled);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) {
				return { wsEndpoint, daemonName: name, projectDir: client.projectDir };
			}

			await stopQuietly(client, name, "Shared browser", opts.signal);
			continue;
		}
		try {
			const started = await client.request(
				{
					op: "start",
					spec: {
						name,
						application: launch.executablePath,
						args: launch.args,
						env: {},
						cwd: client.projectDir,
						pty: false,
						ready: { log: READY_LOG_PATTERN, timeoutMs: READY_TIMEOUT_MS },
						restart: "no",
						persist: false,
						detached: false,
					},
				},
				opts.signal,
			);
			if (started.op !== "start") continue;
			const wsEndpoint = started.readyTimedOut ? undefined : wsEndpointOf(started.daemon);
			if (wsEndpoint && (await probeEndpoint(wsEndpoint))) {
				return { wsEndpoint, daemonName: name, projectDir: client.projectDir };
			}
			await stopQuietly(client, name, "Shared browser", opts.signal);
		} catch (error) {
			throwIfAborted(opts.signal);

			logger.debug("Shared browser start contention", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return null;
}
