import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { matchesKey, parseKey, replaceTabs, StdinBuffer, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { BINARY_NAME } from "@oh-my-pi/pi-utils/dirs";
import chalk from "chalk";

import { closeDaemonClients } from "../launch/client";
import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { connectSessionRpc, type SessionRpcConnection } from "./client";

const commandOutput = {
	role: (role: string, text: string): string =>
		truncateToWidth(`${chalk.bold(cleanLine(role))}: ${cleanLine(text)}`, terminalWidth()),
	system: (text: string): string => chalk.dim(truncateLine(text)),
};

import { ensureSessionHost, stopSessionHost } from "./ensure";

const REPLAY_LINE_WIDTH = 120;
const DEFAULT_REPLAY_MESSAGES = 10;
const CONTROL_TIMEOUT_MS = 20_000;

export interface AttachCommandArgs {
	session?: string;
	dir?: string;
	messages?: number;
	stop?: boolean;
}

function terminalWidth(): number {
	return process.stdout.isTTY && process.stdout.columns > 0 ? process.stdout.columns : REPLAY_LINE_WIDTH;
}

function cleanLine(line: string): string {
	return replaceTabs(sanitizeText(line)).replaceAll("\n", " ");
}

function truncateLine(line: string): string {
	return truncateToWidth(cleanLine(line), terminalWidth());
}

function printNotice(text: string): void {
	for (const line of text.split("\n")) {
		const clean = cleanLine(line);
		const lines = process.stdout.isTTY ? wrapTextWithAnsi(clean, terminalWidth()) : [clean];
		for (const wrapped of lines) console.log(chalk.dim(wrapped));
	}
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (block.type === "text") return block.text;
			if (block.type === "toolCall") return `[tool call: ${block.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function renderMessage(message: AgentMessage): void {
	if (message.role === "bashExecution") {
		const execution = message as { command?: string; output?: string };
		if (execution.command) console.log(commandOutput.role("bash", `$ ${execution.command}`));
		for (const rawLine of (execution.output ?? "").split("\n")) {
			if (rawLine.trim()) console.log(commandOutput.system(rawLine));
		}
		return;
	}
	const text = messageText(message).trim();
	if (!text) return;
	const role = message.role === "user" ? "you" : message.role === "toolResult" ? "tool" : message.role;
	for (const rawLine of text.split("\n")) {
		console.log(commandOutput.role(role, rawLine));
	}
}

async function resolveSessionFile(projectDir: string, sessionArg: string | undefined): Promise<string | undefined> {
	if (sessionArg) {
		// Direct file paths win before id/name matching.
		if (sessionArg.endsWith(".jsonl") && (await Bun.file(sessionArg).exists())) return sessionArg;
		const resolved = await resolveResumableSession(sessionArg, projectDir);
		if (!resolved) return undefined;
		return resolved.session.path;
	}
	const sessionDir = SessionManager.getDefaultSessionDir(projectDir);
	return (await findMostRecentSession(sessionDir)) ?? undefined;
}

interface RequestResult {
	success: boolean;
	data?: unknown;
	error?: string;
}

export class AttachClient {
	#connection: SessionRpcConnection;
	#pending = new Map<string, (result: RequestResult) => void>();
	#counter = 0;
	#pump: Promise<void>;
	#closedError: string | undefined;

	constructor(connection: SessionRpcConnection) {
		this.#connection = connection;
		this.#pump = this.#runPump();
	}

	#runPump(): Promise<void> {
		const pump = async (): Promise<void> => {
			for (;;) {
				const frame = await this.#connection.frames.next();
				const record = frame as { type?: string; id?: unknown };
				if (record.type === "response" && typeof record.id === "string") {
					const resolver = this.#pending.get(record.id);
					if (resolver) {
						this.#pending.delete(record.id);
						const response = frame as { success?: boolean; data?: unknown; error?: string };
						resolver({ success: response.success === true, data: response.data, error: response.error });
						continue;
					}
				}
				renderEvent(frame);
			}
		};
		return pump().catch(error => {
			this.#finishPending(error instanceof Error ? error.message : String(error));
		});
	}

	send(command: Record<string, unknown>): string {
		const id = `attach-${++this.#counter}`;
		this.#connection.sendCommand({ id, ...command });
		return id;
	}

	async request(command: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<RequestResult> {
		if (this.#closedError) return { success: false, error: this.#closedError };
		const id = this.send(command);
		const { promise, resolve } = Promise.withResolvers<RequestResult>();
		this.#pending.set(id, resolve);
		const timer = setTimeout(() => {
			if (this.#pending.delete(id))
				resolve({ success: false, error: `timed out waiting for ${String(command.type)}` });
		}, timeoutMs);
		try {
			return await promise;
		} finally {
			clearTimeout(timer);
		}
	}

	#finishPending(error: string): void {
		this.#closedError ??= error;
		for (const resolve of this.#pending.values()) resolve({ success: false, error: this.#closedError });
		this.#pending.clear();
	}

	close(): void {
		this.#finishPending("session RPC connection closed");
		this.#connection.close();
		void this.#pump;
	}
}

function renderEvent(frame: object): void {
	const event = frame as { type?: string; [key: string]: unknown };
	switch (event.type) {
		case "agent_start":
			console.log(commandOutput.system("── agent turn started ──"));
			break;
		case "agent_end":
			console.log(commandOutput.system("── agent turn finished ──"));
			break;
		case "message_end": {
			const message = event.message as AgentMessage | undefined;
			if (message?.role === "assistant" || message?.role === "user") renderMessage(message);
			break;
		}
		case "tool_execution_start": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			console.log(chalk.cyan(truncateLine(`▸ ${toolName} …`)));
			break;
		}
		case "tool_execution_end": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			const isError = event.isError === true;
			console.log(chalk[isError ? "red" : "cyan"](truncateLine(`▸ ${toolName} ${isError ? "failed" : "done"}`)));
			break;
		}
		case "command_output": {
			const text = typeof event.text === "string" ? event.text : "";
			for (const line of text.split("\n")) console.log(commandOutput.system(line));
			break;
		}
		case "auto_compaction_start":
			console.log(commandOutput.system("── auto-compaction started ──"));
			break;
		case "auto_compaction_end":
		case "compaction_complete":
			console.log(commandOutput.system("── compaction finished ──"));
			break;
		default:
			break;
	}
}

export async function runAttachCommand(args: AttachCommandArgs): Promise<void> {
	const projectDir = path.resolve(args.dir ?? process.cwd());

	if (args.stop) {
		if (!args.session) {
			console.error(chalk.red(`--stop needs the session to stop: ${BINARY_NAME} attach --stop <session-id|file>`));
			process.exitCode = 1;
			return;
		}
		const sessionFile = await resolveSessionFile(projectDir, args.session);
		if (!sessionFile || !(await Bun.file(sessionFile).exists())) {
			console.error(chalk.red(truncateLine(`Session not found: ${args.session}`)));
			process.exitCode = 1;
			return;
		}
		try {
			await stopSessionHost(projectDir, sessionFile);
			console.log(chalk.green(truncateLine(`Stopped session host for ${path.basename(sessionFile)}`)));
		} finally {
			// Stopping is a one-shot command: drop the broker connection so the
			// process can exit instead of idling on an open control socket.
			await closeDaemonClients();
		}
		return;
	}

	let sessionFile: string | undefined;
	if (args.session) {
		sessionFile = await resolveSessionFile(projectDir, args.session);
		if (!sessionFile || !(await Bun.file(sessionFile).exists())) {
			console.error(chalk.red(truncateLine(`Session not found: ${args.session}`)));
			process.exitCode = 1;
			return;
		}
	} else {
		sessionFile = await resolveSessionFile(projectDir, undefined);
		if (!sessionFile) {
			console.error(chalk.red(truncateLine(`No sessions found for ${projectDir}.`)));
			console.error(
				chalk.dim(`Run ${BINARY_NAME} first, or name a session: ${BINARY_NAME} attach <session-id|file>`),
			);
			process.exitCode = 1;
			return;
		}
	}

	const host = await ensureSessionHost(projectDir, sessionFile);
	const connection = await connectSessionRpc(host.socket);
	const client = new AttachClient(connection);

	const negotiate = await client.request({ type: "negotiate_protocol", protocolVersion: 2 });
	if (!negotiate.success) {
		console.error(chalk.red("Session host did not accept the connection."));
		client.close();
		process.exitCode = 1;
		return;
	}

	const state = await client.request({ type: "get_state" });
	if (state.success) {
		const data = state.data as { sessionName?: string; model?: { id?: string } } | undefined;
		console.log(chalk.bold(truncateLine(`attached: ${data?.sessionName || path.basename(sessionFile)}`)));
		const modelId = data?.model?.id;
		if (modelId) console.log(chalk.dim(truncateLine(`model: ${modelId}`)));
	} else {
		console.error(chalk.red(truncateLine(`get_state failed: ${state.error}`)));
	}

	const replayCount = args.messages ?? DEFAULT_REPLAY_MESSAGES;
	const messages = await client.request({ type: "get_messages" });
	if (messages.success) {
		const list = (messages.data as { messages?: AgentMessage[] } | undefined)?.messages ?? [];
		const recent = list.slice(-replayCount);
		if (recent.length > 0) {
			console.log(commandOutput.system(`── last ${recent.length} message(s) ──`));
			for (const message of recent) renderMessage(message);
		}
	}

	let detached = false;
	let interacted = false;
	let restoreInput = (): void => {};
	const detach = (reason: string): void => {
		if (detached) return;
		detached = true;
		restoreInput();
		client.close();
		printNotice(`\n${reason} — session keeps running daemon-side.`);
		// Keep the command on one logical line so copying terminal-wrapped
		// long paths does not insert newline characters into the argument.
		console.log(
			chalk.dim(
				`Reattach with: ${BINARY_NAME} attach ${Bun.$.escape(cleanLine(path.resolve(sessionFile)))} --dir ${Bun.$.escape(cleanLine(projectDir))}`,
			),
		);
		process.exit(0);
	};

	// Piped stdin hands over every line at once and closes immediately, so a
	// scripted attach must outlive its own input: leave only once the commands
	// it dispatched have answered. A terminal user asking to leave gets out now.
	const scripted = process.stdin.isTTY !== true;
	const inFlight = new Set<Promise<unknown>>();
	const track = (work: Promise<unknown>): void => {
		const tracked = work.finally(() => {
			inFlight.delete(tracked);
		});
		inFlight.add(tracked);
	};
	let leaving = false;
	const leave = (reason: string): void => {
		if (detached || leaving) return;
		if (!scripted || inFlight.size === 0) {
			detach(reason);
			return;
		}
		leaving = true;
		void (async () => {
			while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
		})().finally(() => {
			leaving = false;
			detach(reason);
		});
	};

	const abortTurn = (): void => {
		client.send({ type: "abort" });
		console.log(chalk.yellow("abort requested"));
	};

	// Use the terminal's incremental parser: native data chunks need not align
	// with key sequences. Only a complete Escape key aborts; Alt, CSI, SS3,
	// pasted text and terminal string controls must not be mistaken for it.
	const terminalInput = process.stdin.isTTY ? new PassThrough() : undefined;
	const inputBuffer = terminalInput ? new StdinBuffer({ timeout: 50 }) : undefined;
	const wasRaw = process.stdin.isRaw;
	if (terminalInput) process.stdin.setRawMode(true);
	restoreInput = () => {
		inputBuffer?.destroy();
		if (terminalInput) process.stdin.setRawMode(wasRaw);
	};
	inputBuffer?.on("data", sequence => {
		if (detached) return;
		if (matchesKey(sequence, "escape")) {
			client.send({ type: "abort" });
			detach("esc — aborted and detached");
			return;
		}
		// Replies and string controls are not editing keys. Do not let
		// readline turn their payloads into part of a shell command.
		if (sequence.startsWith("\x1b") && !parseKey(sequence)) return;
		terminalInput!.write(sequence);
	});
	inputBuffer?.on("paste", text => terminalInput!.write(sanitizeText(text)));
	if (inputBuffer) {
		process.stdin.on("data", (chunk: Buffer | string) => inputBuffer.process(chunk));
		process.stdin.on("end", () => terminalInput!.end());
	}

	let lastInterrupt = 0;
	const onSigInt = (): void => {
		const now = Date.now();
		if (now - lastInterrupt < 3_000) {
			detach("detached");
			return;
		}
		lastInterrupt = now;
		abortTurn();
	};
	process.on("SIGINT", onSigInt);

	const rl = readline.createInterface({
		input: terminalInput ?? process.stdin,
		output: process.stdin.isTTY ? process.stdout : undefined,
		terminal: process.stdin.isTTY === true,
	});
	rl.on("SIGINT", onSigInt);
	rl.on("line", line => {
		const text = line.trim();
		if (!text) return;
		interacted = true;
		if (text === "/detach" || text === "/quit") {
			// Claim the reason before readline's close event calls it an EOF.
			leave("detached");
			rl.close();
			return;
		}
		if (text === "/stop") {
			track(
				stopSessionHost(projectDir, sessionFile).then(() => {
					restoreInput();
					console.log(chalk.green("session host stopped"));
					process.exit(0);
				}),
			);
			return;
		}
		if (text === "/abort") {
			abortTurn();
			return;
		}
		if (text.startsWith("/bash ")) {
			const command = text.slice("/bash ".length);
			track(
				client.request({ type: "bash", command }, 120_000).then(result => {
					if (result.success) {
						const output =
							typeof (result.data as { output?: string })?.output === "string"
								? (result.data as { output: string }).output
								: JSON.stringify(result.data);
						for (const out of output.split("\n")) console.log(commandOutput.system(out));
					} else {
						console.log(chalk.red(truncateLine(`bash failed: ${result.error}`)));
					}
				}),
			);
			return;
		}
		if (text === "/help") {
			printNotice(
				"/bash <cmd>  /abort  /stop  /detach  /help — Esc aborts and detaches; anything else is sent as a prompt",
			);
			return;
		}
		client.send({ type: "prompt", message: text });
	});
	// A piped attach that started the host and then saw stdin close without a
	// single line would strand a session host — and the broker supervising it —
	// with no one to talk to. Hand back exactly what this invocation created.
	rl.on("close", () => {
		if (detached) return;
		if (interacted || !host.created || !scripted) {
			leave("input closed");
			return;
		}
		detached = true;
		restoreInput();
		client.close();
		void (async () => {
			try {
				await stopSessionHost(projectDir, sessionFile);
			} finally {
				await closeDaemonClients();
			}
		})()
			.catch(() => undefined)
			.finally(() => {
				console.error(chalk.red("stdin closed before any input — stopped the session host this attach started."));
				console.error(
					chalk.dim(
						`Attach from a terminal, or pipe commands: echo /help | ${BINARY_NAME} attach <session-id|file>`,
					),
				);
				process.exit(1);
			});
	});
	// Advertise readiness only after raw mode and command handlers are installed.
	printNotice(
		"commands: /bash <cmd>  /abort  /stop  /detach  (Esc aborts and detaches; Ctrl-C aborts, twice detaches)",
	);
}
