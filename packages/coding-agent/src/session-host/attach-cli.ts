import * as path from "node:path";
import * as readline from "node:readline";

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { replaceTabs } from "@oh-my-pi/pi-tui";
import chalk from "chalk";

import { findMostRecentSession, resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { connectSessionRpc, type SessionRpcConnection } from "./client";

const commandOutput = {
	role: (role: string, text: string): string => `${chalk.bold(role)}: ${text}`,
	system: (text: string): string => chalk.dim(text),
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

function truncateLine(line: string, width = REPLAY_LINE_WIDTH): string {
	const clean = replaceTabs(line);
	if (clean.length <= width) return clean;
	return `${clean.slice(0, width - 1)}…`;
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
		if (execution.command) console.log(commandOutput.role("bash", truncateLine(`$ ${execution.command}`)));
		for (const rawLine of (execution.output ?? "").split("\n")) {
			if (rawLine.trim()) console.log(commandOutput.system(truncateLine(rawLine)));
		}
		return;
	}
	const text = messageText(message).trim();
	if (!text) return;
	const role = message.role === "user" ? "you" : message.role === "toolResult" ? "tool" : message.role;
	for (const rawLine of text.split("\n")) {
		console.log(commandOutput.role(role, truncateLine(rawLine)));
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
		return pump().catch(() => {
			// connection closed — pending requests settle via request timeouts
		});
	}

	send(command: Record<string, unknown>): string {
		const id = `attach-${++this.#counter}`;
		this.#connection.sendCommand({ id, ...command });
		return id;
	}

	async request(command: Record<string, unknown>, timeoutMs = CONTROL_TIMEOUT_MS): Promise<RequestResult> {
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

	close(): void {
		this.#connection.close();
		void this.#pump;
	}
}

function renderEvent(frame: object): void {
	const event = frame as { type?: string; [key: string]: unknown };
	switch (event.type) {
		case "agent_start":
			console.log(chalk.dim("── agent turn started ──"));
			break;
		case "agent_end":
			console.log(chalk.dim("── agent turn finished ──"));
			break;
		case "message_end": {
			const message = event.message as AgentMessage | undefined;
			if (message?.role === "assistant" || message?.role === "user") renderMessage(message);
			break;
		}
		case "tool_execution_start": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			console.log(chalk.cyan(`▸ ${toolName} …`));
			break;
		}
		case "tool_execution_end": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			const isError = event.isError === true;
			console.log(chalk[isError ? "red" : "cyan"](`▸ ${toolName} ${isError ? "failed" : "done"}`));
			break;
		}
		case "command_output": {
			const text = typeof event.text === "string" ? event.text : "";
			for (const line of text.split("\n")) console.log(commandOutput.system(truncateLine(line)));
			break;
		}
		case "auto_compaction_start":
			console.log(chalk.dim("── auto-compaction started ──"));
			break;
		case "auto_compaction_end":
		case "compaction_complete":
			console.log(chalk.dim("── compaction finished ──"));
			break;
		default:
			break;
	}
}

export async function runAttachCommand(args: AttachCommandArgs): Promise<void> {
	const projectDir = path.resolve(args.dir ?? process.cwd());

	if (args.stop) {
		if (!args.session) {
			console.error(chalk.red("--stop requires --session <file|id> to identify the hosted session."));
			process.exitCode = 1;
			return;
		}
		const sessionFile = await resolveSessionFile(projectDir, args.session);
		if (!sessionFile || !(await Bun.file(sessionFile).exists())) {
			console.error(chalk.red(`Session not found: ${args.session}`));
			process.exitCode = 1;
			return;
		}
		await stopSessionHost(projectDir, sessionFile);
		console.log(chalk.green(`Stopped session host for ${path.basename(sessionFile)}`));
		return;
	}

	let sessionFile: string | undefined;
	if (args.session) {
		sessionFile = await resolveSessionFile(projectDir, args.session);
		if (!sessionFile || !(await Bun.file(sessionFile).exists())) {
			console.error(chalk.red(`Session not found: ${args.session}`));
			process.exitCode = 1;
			return;
		}
	} else {
		sessionFile = await resolveSessionFile(projectDir, undefined);
		if (!sessionFile) {
			console.error(chalk.red(`No sessions found for ${projectDir}. Run proto first, or pass --session.`));
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
		console.log(chalk.bold(`attached: ${data?.sessionName || path.basename(sessionFile)}`));
		const modelId = data?.model?.id;
		if (modelId) console.log(chalk.dim(`model: ${modelId}`));
	} else {
		console.error(chalk.red(`get_state failed: ${state.error}`));
	}

	const replayCount = args.messages ?? DEFAULT_REPLAY_MESSAGES;
	const messages = await client.request({ type: "get_messages" });
	if (messages.success) {
		const list = (messages.data as { messages?: AgentMessage[] } | undefined)?.messages ?? [];
		const recent = list.slice(-replayCount);
		if (recent.length > 0) {
			console.log(chalk.dim(`── last ${recent.length} message(s) ──`));
			for (const message of recent) renderMessage(message);
		}
	}

	console.log(chalk.dim("commands: /bash <cmd>  /abort  /stop  /detach  (Ctrl-C aborts, twice detaches)"));

	let detached = false;
	const detach = (reason: string): void => {
		if (detached) return;
		detached = true;
		client.close();
		console.log(
			chalk.dim(
				`\n${reason} — session keeps running daemon-side. Reattach with: proto attach --session ${path.basename(sessionFile)}`,
			),
		);
		process.exit(0);
	};

	const abortTurn = (): void => {
		client.send({ type: "abort" });
		console.log(chalk.yellow("abort requested"));
	};

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

	const rl = readline.createInterface({ input: process.stdin, terminal: process.stdin.isTTY === true });
	rl.on("line", line => {
		const text = line.trim();
		if (!text) return;
		if (text === "/detach" || text === "/quit") {
			rl.close();
			detach("detached");
			return;
		}
		if (text === "/stop") {
			void stopSessionHost(projectDir, sessionFile).then(() => {
				console.log(chalk.green("session host stopped"));
				process.exit(0);
			});
			return;
		}
		if (text === "/abort") {
			abortTurn();
			return;
		}
		if (text.startsWith("/bash ")) {
			const command = text.slice("/bash ".length);
			void client.request({ type: "bash", command }, 120_000).then(result => {
				if (result.success) {
					const output =
						typeof (result.data as { output?: string })?.output === "string"
							? (result.data as { output: string }).output
							: JSON.stringify(result.data);
					for (const out of output.split("\n")) console.log(commandOutput.system(truncateLine(out)));
				} else {
					console.log(chalk.red(`bash failed: ${result.error}`));
				}
			});
			return;
		}
		if (text === "/help") {
			console.log(chalk.dim("/bash <cmd>  /abort  /stop  /detach  /help — anything else is sent as a prompt"));
			return;
		}
		client.send({ type: "prompt", message: text });
	});
	rl.on("close", () => detach("input closed"));
}
