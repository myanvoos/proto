#!/usr/bin/env bun

try {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
} catch {}

import { parentPort } from "node:worker_threads";
import type { CliConfig, CommandMetadata } from "@oh-my-pi/pi-utils/cli";
import {
	BINARY_NAME,
	getActiveProfile,
	MIN_BUN_VERSION,
	resolveProfileEnv,
	setProfile,
	VERSION,
} from "@oh-my-pi/pi-utils/dirs";
import { interceptUnhandledRejections } from "@oh-my-pi/pi-utils/postmortem";
import { setProcessName } from "@oh-my-pi/pi-utils/process-name";
import { declareWorkerHostEntry, installWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import { BLOB_BROKER_WORKER_ARG } from "./blob-broker/protocol";
import { installProfileAlias, resolveProfileAliasCommandFromProcess } from "./cli/profile-alias";
import { extractProfileFlags } from "./cli/profile-bootstrap";
import type { WorkerInbound as JsWorkerInbound, WorkerOutbound as JsWorkerOutbound } from "./eval/js/worker-protocol";
import { DAEMON_BROKER_WORKER_ARG } from "./launch/protocol";
import { COMPUTER_WORKER_ARG } from "./tools/computer/protocol";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(1);
}

setProcessName(BINARY_NAME);

const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true";

async function showHelp(config: CliConfig<CommandMetadata>): Promise<void> {
	const [{ renderRootHelp }, { getExtraHelpText }] = await Promise.all([
		import("@oh-my-pi/pi-utils/cli"),
		import("./cli/help-extra"),
	]);
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}
const TINY_WORKER_ARG = "__proto_worker_tiny_inference";
const TAB_WORKER_ARG = "__proto_worker_tab";
const JS_EVAL_WORKER_ARG = "__proto_worker_js_eval";
const JS_EVAL_PROCESS_ARG = "__proto_worker_js_eval_process";

async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === TINY_WORKER_ARG) {
		await runTinyWorker();
		return true;
	}

	if (arg === TAB_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === COMPUTER_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		// Keep this worker-only dependency out of the regular CLI startup graph.
		const { startComputerWorker } = await import("./tools/computer/worker-entry");
		startComputerWorker();
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./eval/js/worker-entry");
		return true;
	}
	if (arg === JS_EVAL_PROCESS_ARG) {
		// Keep this worker-only dependency out of the regular CLI startup graph.
		const { startJsEvalProcess } = await import("./eval/js/process-entry");
		await runIpcSubprocessWorker<JsWorkerInbound, JsWorkerOutbound>(
			transport => startJsEvalProcess(transport, interceptUnhandledRejections),
			{ rethrowConnectedSendErrors: true },
		);
		return true;
	}
	if (arg === DAEMON_BROKER_WORKER_ARG) {
		const { startDaemonBrokerFromEnvironment } = await import("./launch/broker");
		await startDaemonBrokerFromEnvironment();
		return true;
	}
	if (arg === BLOB_BROKER_WORKER_ARG) {
		const { startBlobBrokerFromEnvironment } = await import("./blob-broker/server");
		await startBlobBrokerFromEnvironment();
		return true;
	}
	return false;
}

async function runIpcSubprocessWorker<In, Out>(
	start: (transport: {
		send(message: Out): void;
		sendAndFlush(message: Out): Promise<void>;
		onMessage(handler: (message: In) => void): () => void;
	}) => void,
	options?: {
		rethrowConnectedSendErrors?: boolean;
	},
): Promise<void> {
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;

	const ipcSend = (): IpcSend | undefined => (process as NodeJS.Process & { send?: IpcSend }).send;
	const send = (message: Out): void => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch (error) {
			if (options?.rethrowConnectedSendErrors && process.connected) throw error;
			shutdown();
		}
	};
	const sendAndFlush = (message: Out): Promise<void> => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			sender.call(process, message, () => resolve());
		} catch {
			shutdown();
			resolve();
		}
		return promise;
	};
	start({
		send,
		sendAndFlush,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as In);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	const keepalive = setInterval(() => {}, 2 ** 30);

	process.on("disconnect", () => shutdown());
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
	}
	process.kill(process.pid, "SIGKILL");
}

async function runTinyWorker(): Promise<void> {
	const { startTinyTitleWorker } = await import("./tiny/worker");
	await runIpcSubprocessWorker(startTinyTitleWorker);
}

export async function runCli(argv: string[]): Promise<void> {
	let resolvedArgv = argv;
	try {
		const extracted = extractProfileFlags(resolvedArgv);
		resolvedArgv = extracted.argv;
		if (extracted.profile !== undefined) {
			setProfile(extracted.profile);
		} else {
			setProfile(resolveProfileEnv(process.env.PROTO_PROFILE, process.env.PI_PROFILE));
		}
		if (extracted.aliasName !== undefined) {
			const profile = extracted.profile ?? getActiveProfile();
			if (!profile) {
				throw new Error("--alias requires --profile <name> or PROTO_PROFILE");
			}
			const result = await installProfileAlias({
				profile,
				aliasName: extracted.aliasName,
				command: resolveProfileAliasCommandFromProcess(),
			});
			process.stdout.write(
				`Created ${result.aliasName} for profile ${result.profile} in ${result.configPath}\n` +
					`Restart your shell or run: ${result.reloadedWith}\n` +
					`Then use: ${result.aliasName} update, ${result.aliasName} --version, or ${result.aliasName}\n`,
			);
			return;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${message}\n`);
		process.exitCode = 1;
		return;
	}

	if (isWorkerHostSelector(resolvedArgv[0])) {
		const dispatched = await runWorkerEntrypoint(resolvedArgv[0]);
		if (!dispatched) {
			process.stderr.write(`Error: unknown worker selector: ${resolvedArgv[0]}\n`);
			process.exitCode = 1;
		}
		return;
	}

	if (isProcessEntry) declareWorkerHostEntry();

	const { installGlobalProxyFetch } = await import("@oh-my-pi/pi-ai/utils/proxy");
	installGlobalProxyFetch();

	if (resolvedArgv[0] === "--license") {
		// Keep these large assets out of normal startup; they are only needed for --license.
		const [{ default: rootLicense }, { default: thirdPartyNotices }] = await Promise.all([
			import("./tools/browser/relay/extension-assets/LICENSE.txt", { with: { type: "text" } }),
			import("./tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt", { with: { type: "text" } }),
		]);
		process.stdout.write(
			`PROTO License and Third-Party Notices\n\n${rootLicense.trimEnd()}\n\n${thirdPartyNotices.trimEnd()}\n`,
		);
		return;
	}
	let stopStartupComposer: (() => void) | undefined;
	if (
		!process.env.PI_TIMING &&
		process.stdin.isTTY === true &&
		process.stdout.isTTY === true &&
		(resolvedArgv.length === 0 || (resolvedArgv.length === 1 && resolvedArgv[0] === "--no-session"))
	) {
		const { beginStartupComposer, stopPendingStartupComposer } = await import("./modes/startup-composer");
		beginStartupComposer({ version: VERSION });
		stopStartupComposer = stopPendingStartupComposer;
	}

	try {
		const [{ run }, { commands, resolveCliArgv }] = await Promise.all([
			import("@oh-my-pi/pi-utils/cli"),
			import("./cli-commands"),
		]);

		const resolved = resolveCliArgv(resolvedArgv);
		if ("error" in resolved) {
			process.stderr.write(`error: ${resolved.error}\n`);
			process.exitCode = 1;
			return;
		}
		await run({ bin: BINARY_NAME, version: VERSION, argv: resolved.argv, commands, metadataHelp: showHelp });
	} finally {
		stopStartupComposer?.();
	}
}

if (isProcessEntry || !Bun.isMainThread) {
	runCli(process.argv.slice(2)).catch((err: unknown) => {
		process.stderr.write(`${Bun.inspect(err, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
}
