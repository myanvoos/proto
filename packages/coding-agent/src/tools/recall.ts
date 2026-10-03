import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { executeJs } from "../eval/js/executor";
import recallDescription from "../prompts/tools/recall.md" with { type: "text" };
import type { ExecutionMetadata } from "../session/execution-metadata";
import {
	executeRecall,
	getActiveLineageEntryIds,
	loadAllMessages,
	type RecallContext,
} from "../vendor/pi-blackhole/index.js";
import type { ToolSession } from "./index";
import type { OutputMeta } from "./output-meta";
import { ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const recallSchema = type({
	"query?": type("string").describe(
		"Text/regex search; #N expands an entry; #N:path drills file content; #N:text pages message text; optional :offset:limit or :full; 12-char hex observation id. With code: the question to answer.",
	),
	"expand?": type("number.integer >= 0").array().describe("Entry indices to expand, alone or with search."),
	"page?": type("number.integer >= 1").describe("Result page, 1-based; default 1."),
	"scope?": type('"lineage" | "all"').describe("Active lineage (default), or every branch of this session."),
	"mode?": type('"hybrid" | "file" | "touched"').describe(
		"hybrid (default): message and file-write search; file: file writes only; touched: files grouped by path.",
	),
	"code?": type("string > 0").describe(
		"JavaScript function expression, e.g. async ({query, entries}) => { ... }. Runs in a fresh Bun kernel with completion/agent/parallel/pipeline. Return the answer; requires query; cannot combine with expand/page/mode.",
	),
	"timeout?": type("0 < number <= 3600").describe(
		"Code deadline in seconds, including model calls; default 120. Only with code.",
	),
});

export interface RecallToolDetails {
	meta?: OutputMeta;
	execution?: ExecutionMetadata;
	scope?: "lineage" | "all";
	entries?: number;
}

export class RecallTool implements AgentTool<typeof recallSchema, RecallToolDetails> {
	readonly name = "recall";
	readonly label = "Recall";
	readonly loadMode = "essential";
	readonly description = recallDescription;
	readonly parameters = recallSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: typeof recallSchema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<RecallToolDetails>> {
		throwIfAborted(signal);
		if (params.code !== undefined) {
			if (!params.query?.trim())
				throw new ToolError("recall code requires a non-empty query describing the question.");
			if (params.expand !== undefined || params.page !== undefined || params.mode !== undefined) {
				throw new ToolError(
					"recall code cannot be combined with expand, page, or mode; select entries inside the function.",
				);
			}
			if (
				!this.session.settings.get("bash.enabled") ||
				((this.session.restrictToolNames || this.session.isToolActive !== undefined) &&
					this.session.isToolActive?.("bash") !== true)
			) {
				throw new ToolError("recall code requires bash execution permission; ordinary recall remains available.");
			}
		} else if (params.timeout !== undefined) {
			throw new ToolError("recall timeout requires code.");
		}
		await this.session.sessionManager?.flush();
		const sessionFile = this.session.getSessionFile();
		if (!sessionFile) return toolResult().text("No session file available.").done();
		const manager = this.session.sessionManager;
		if (!manager) throw new ToolError("Session history is unavailable for recall.");
		const context: RecallContext = {
			cwd: this.session.cwd,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getBranch: () => manager.getBranch(),
				getEntries: () => manager.getEntries(),
			},
		};
		if (params.code === undefined) {
			const result = await executeRecall(params, context);
			return { ...result, details: {} };
		}
		this.session.assertEvalExecutionAllowed?.();
		const scope = params.scope ?? "lineage";
		const allowed = scope === "lineage" ? getActiveLineageEntryIds(context.sessionManager) : undefined;
		const { rendered, rawMessages } = loadAllMessages(sessionFile, true, allowed);
		// Snapshot the scoped history, not its search results: semantic questions need not share words with evidence.
		await using temporary = await TempDir.create("@recall-query-");
		const snapshot = temporary.join("transcript.jsonl");
		const writer = Bun.file(snapshot).writer();
		try {
			for (const [index, entry] of rendered.entries()) {
				throwIfAborted(signal);
				writer.write(`${JSON.stringify({ ...entry, message: rawMessages[index] })}\n`);
				await writer.flush();
			}
		} finally {
			await writer.end();
		}
		const owner = `recall:${crypto.randomUUID()}`;
		const abort = new AbortController();
		const executionSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
		const artifact = await this.session.allocateOutputArtifact?.("recall");
		const code = [
			'import * as recallLines from "node:readline";',
			"await (async () => {",
			`const input = { query: ${JSON.stringify(params.query)}, scope: ${JSON.stringify(scope)}, entries: [] };`,
			`const lines = recallLines.createInterface({ input: fs.createReadStream(${JSON.stringify(snapshot)}), crlfDelay: Infinity });`,
			"for await (const line of lines) input.entries.push(JSON.parse(line));",
			`const run = (${params.code}\n);`,
			'if (typeof run !== "function") throw new TypeError("recall code must be a function expression");',
			"const answer = await run(input);",
			'if (answer === undefined) throw new TypeError("recall code must return an answer");',
			'console.log(typeof answer === "string" ? answer : JSON.stringify(answer));',
			"})();",
		].join("\n");
		try {
			const execution = executeJs(code, {
				runtime: "bun",
				cwd: this.session.cwd,
				session: this.session,
				sessionId: owner,
				kernelOwnerId: owner,
				sessionFile,
				timeoutMs: (params.timeout ?? 120) * 1000,
				signal: executionSignal,
				artifactId: artifact?.id,
				artifactPath: artifact?.path,
			});
			const result = await (this.session.trackEvalExecution?.(execution, abort) ?? execution);
			const output =
				result.cancelled && !result.timedOut
					? `${result.output}\nRecall query cancelled; partial output is not a completed answer.`.trimStart()
					: result.output;
			return toolResult<RecallToolDetails>({ scope, entries: rendered.length, execution: result.execution })
				.text(output)
				.truncationFromSummary(result, { direction: "tail" })
				.error(result.cancelled || result.exitCode !== 0)
				.done();
		} finally {
			abort.abort();
			await disposeVmContextsByOwner(owner);
		}
	}
}
