import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { formatConfigIssue } from "../config/settings-normalize";
import { formatSkillWarning } from "../extensibility/skills";
import { MCPManager } from "../mcp/manager";
import { formatMcpConfigError, formatMcpServerFailure } from "../mcp/startup-events";
import { OrchestratorRuntime } from "../orchestrator/runtime";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";

export interface PrintModeOptions {
	mode: "text" | "json";

	messages?: string[];

	initialMessage?: string;

	initialImages?: ImageContent[];

	printThoughts?: boolean;
}

export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;

export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;

function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

function reportStartupDiagnostics(session: AgentSession): void {
	for (const issue of settings.getConfigIssues()) {
		process.stderr.write(`${formatConfigIssue(issue)}\n`);
	}
	for (const warning of session.skillWarnings) {
		process.stderr.write(`${formatSkillWarning(warning)}\n`);
	}
	const diagnostics = MCPManager.instance()?.getStartupDiagnostics();
	for (const error of diagnostics?.configErrors ?? []) {
		process.stderr.write(`${formatMcpConfigError(error, { untruncated: true })}\n`);
	}
	for (const failure of diagnostics?.failures ?? []) {
		process.stderr.write(`${formatMcpServerFailure(failure, { untruncated: true })}\n`);
	}
}

export function printableEvent(event: AgentSessionEvent): unknown {
	switch (event.type) {
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}

export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts } = options;

	let stdoutTail: Promise<void> = Promise.resolve();
	const writeStdoutLine = (text: string): void => {
		stdoutTail = stdoutTail.then(() => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			process.stdout.write(text, err => {
				if (err) reject(err);
				else resolve();
			});
			return promise;
		});
	};

	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeStdoutLine(`${JSON.stringify(header)}\n`);
		}
	}

	reportStartupDiagnostics(session);

	await initializeExtensions(session, {
		mode: mode === "json" ? "json" : "print",
		reportSendError: (action, err) => {
			process.stderr.write(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
			);
		},
		reportRuntimeError: err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		},
	});

	session.subscribe(event => {
		if (mode === "json") {
			writeStdoutLine(`${JSON.stringify(printableEvent(event))}\n`);
			return;
		}
		// Conditions the TUI shows as a notice have no other headless surface.
		if (event.type === "notice" && event.level !== "info") {
			process.stderr.write(`${event.level === "error" ? "Error" : "Warning"}: ${sanitizeText(event.message)}\n`);
			return;
		}
		// Without this the run looks hung while recovery retries a failing provider:
		// json consumers already receive the events, text mode saw only "Working...".
		if (event.type === "auto_retry_start") {
			const delaySeconds = Math.max(0, Math.round(event.delayMs / 100) / 10);
			process.stderr.write(
				`Provider error (retry ${event.attempt}/${event.maxAttempts} in ${delaySeconds}s): ${sanitizeText(event.errorMessage)}\n`,
			);
		}
	});

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	if (initialMessage !== undefined) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
	}

	for (const message of messages) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:next", () => session.prompt(message));
	}

	session.prepareForHeadlessAdvisorDrain();

	// A run cut short by --max-time is not a successful run: report it on stderr and
	// exit non-zero, after any partial output has been written.
	// Disposing the session terminates every worker turn still in flight. The run is over either way,
	// but the operator has to learn that delegated work was cut off rather than finished.
	const reportAbandonedWorkers = (): void => {
		const parent = session.orchestratorParent;
		if (!parent) return;
		const active = OrchestratorRuntime.global().activeTurns(parent);
		if (active.length === 0) return;
		const detail = active
			.map(worker => {
				const queued = worker.queued > 0 ? `, ${worker.queued} queued` : "";
				return `${worker.id} (label ${worker.label}, turn ${worker.turn}${queued})`;
			})
			.join(", ");
		process.stderr.write(
			`Warning: the run ended with ${active.length} worker turn${active.length === 1 ? "" : "s"} still running; ` +
				`${active.length === 1 ? "it was" : "they were"} terminated: ${detail}. ` +
				"Wait for workers with orchestrate_wait before finishing.\n",
		);
	};

	const failRun = async (errorLine: string): Promise<never> => {
		await session.waitForAdvisorCatchup(PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS);
		await flushTelemetryExport();
		await stdoutTail;
		reportAbandonedWorkers();
		await session.dispose();
		const flushed = process.stderr.write(`${errorLine}\n`);
		if (!flushed) await new Promise<void>(resolve => process.stderr.once("drain", () => resolve()));
		process.exit(1);
	};

	const assistantMsg = session.getLastAssistantMessage();
	const turnFailed =
		assistantMsg !== undefined && (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted");

	if (mode === "text") {
		if (assistantMsg) {
			if (assistantMsg.errorMessage && !turnFailed) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Partial output of a failed or truncated turn still belongs on stdout;
			// only the exit code and the stderr line mark the run as unsuccessful.
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					writeStdoutLine(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					writeStdoutLine(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
		session.setTextOutputCommitted(true);
	}

	if (session.deadlineExceeded()) {
		const detail = turnFailed ? sanitizeText(assistantMsg?.errorMessage ?? "") : "";
		await failRun(
			`Stopped by --max-time before the run finished; the output is incomplete.${detail ? ` (${detail})` : ""}`,
		);
	}

	// Both modes must report a failed turn through the exit code: json consumers
	// read the event stream, scripts read $?.
	if (turnFailed) {
		await failRun(sanitizeText(assistantMsg?.errorMessage || `Request ${assistantMsg?.stopReason}`));
	}

	await session.waitForAdvisorCatchup(PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS);

	await stdoutTail;
	reportAbandonedWorkers();
	await session.dispose();
}
