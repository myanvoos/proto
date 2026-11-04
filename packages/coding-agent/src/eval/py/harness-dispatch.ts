import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFileWith, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { ExecutionAdmission, executionIdentity } from "../../task/execution-admission";
import { resolveEvalBackends } from "../../tools/eval-backends";
import { type CappedEventDiff, capEventDiff } from "../../utils/diff";
import { namespaceSessionId } from "../backend-helpers";
import { fsObservationLedgerFor } from "../fs-observations";
import {
	assertSessionBridgeToolAvailable,
	authorizeSessionBridgeCall,
	callSessionTool,
	type ToolBridgeOptions,
} from "../js/tool-bridge";
import { kernelLaneSessionId } from "../kernel-control";
import { getKernelLaneConfiguration, setKernelLaneConfiguration } from "../kernel-environment";
import { observeKernelGeneration, takeKernelCellTermination } from "../kernel-session-registry";
import { parseKernelTarget } from "../kernel-target";
import type { EvalDisplayOutput } from "../types";
import { renderKernelDisplay } from "./display";
import {
	closePythonKernelSession,
	executePython,
	listPythonKernelSessions,
	startPythonKernelSession,
} from "./executor";
import type { PythonHarnessContext } from "./harness-types";
import { dispatchPythonStoreRequest } from "./python-store";
import { pythonEnvironmentIdentity, resolveExplicitPythonRuntime } from "./runtime";

function stringArg(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || !value || value.includes("\0"))
		throw new Error(`${key} must be a nonempty string without NUL`);
	return value;
}

function bridgeOptions(context: PythonHarnessContext): ToolBridgeOptions {
	return {
		session: context.session,
		cwd: context.cwd,
		signal: context.signal,
		completionContext: context.completionContext,
		toolCallId: `python-helper-${crypto.randomUUID()}`,
		emitStatus: event => context.emit?.({ type: "status", event }),
	};
}

async function dispatchFilesystem(
	context: PythonHarnessContext,
	operation: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const file = path.resolve(context.cwd, stringArg(args, "path"));
	const ledger = fsObservationLedgerFor(context.session);
	if (operation === "read") {
		assertSessionBridgeToolAvailable(context.session, "read");
		const bytes = Buffer.from(await ledger.readBytes(file));
		context.emit?.({ type: "status", event: { op: "read", path: file, chars: bytes.length } });
		return { data: bytes.toString("base64") };
	}
	if (operation !== "write" && operation !== "replace") throw new Error(`Unknown filesystem operation: ${operation}`);
	assertSessionBridgeToolAvailable(context.session, "bash");
	const guard = ledger.writeGuard(file);
	await guard();
	let bytes: Uint8Array;
	if (operation === "write") {
		const data = args.data;
		if (typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data))
			throw new Error("data must be canonical base64");
		bytes = Buffer.from(data, "base64");
	} else {
		const old = stringArg(args, "old");
		if (typeof args.new !== "string") throw new Error("new must be a string");
		if (args.encoding !== undefined && args.encoding !== "utf-8")
			throw new Error("replace supports UTF-8; use read_bytes/write_bytes for other encodings");
		const count = args.count ?? 1;
		if (!Number.isSafeInteger(count) || (count as number) < 1) throw new Error("count must be a positive integer");
		const source = await Bun.file(file).text();
		const parts = source.split(old);
		if (parts.length - 1 !== count) throw new Error(`Expected exactly ${count} anchors; found ${parts.length - 1}`);
		bytes = Buffer.from(parts.join(args.new));
	}
	let before: Uint8Array | undefined;
	try {
		if ((await Bun.file(file).size) <= 8 * 1024 * 1024) before = await fs.readFile(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	let mode = 0o644;
	let existed = false;
	try {
		const stat = await fs.stat(file);
		existed = true;
		mode = stat.mode & 0o7777;
		await fs.access(file, fs.constants.W_OK);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	context.signal.throwIfAborted();
	await atomicWriteFileWith(
		file,
		async temporary => {
			await Bun.write(temporary, bytes);
		},
		{
			mode,
			beforeCommit: async () => {
				context.signal.throwIfAborted();
				await guard();
			},
		},
	);
	context.session.bumpFileMutationVersion?.(file);
	await ledger.recordWrite(file);
	await ledger.recordRead(file);
	if (!before || !Buffer.from(before).equals(bytes)) {
		let capped: CappedEventDiff | undefined;
		try {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			if (bytes.length <= 8 * 1024 * 1024)
				capped = capEventDiff(before ? decoder.decode(before) : "", decoder.decode(bytes));
		} catch {
			/* Binary writes still report their path without a text hunk. */
		}
		context.emit?.({
			type: "status",
			event: {
				op: "write",
				path: file,
				chars: bytes.length,
				...(capped ? { diff: capped.diff, ...(capped.diffTruncated ? { diffTruncated: true } : {}) } : {}),
			},
		});
		const label = path.relative(context.cwd, file) || file;
		const counts = capped
			? existed
				? ` (+${capped.added} −${capped.removed})`
				: ` (${capped.added} line${capped.added === 1 ? "" : "s"})`
			: "";
		context.emit?.({
			type: "status",
			event: { op: "note", text: `<kernel> note: ${existed ? "wrote" : "created"} ${label}${counts}\n` },
		});
	}
	return bytes.length;
}

// Active wait edges, not execution history: catch A -> B -> A before backend FIFO admission.
const dependencies = new Map<string, Map<string, number>>();
function depend(from: string | undefined, to: string): () => void {
	if (!from) return () => {};
	const seen = new Set<string>();
	function reaches(node: string): boolean {
		if (node === from) return true;
		if (seen.has(node)) return false;
		seen.add(node);
		return [...(dependencies.get(node)?.keys() ?? [])].some(reaches);
	}
	if (reaches(to)) throw new Error("Kernel self-dependency refused: nested kernels cannot wait on an ancestor");
	const outgoing = dependencies.get(from) ?? new Map<string, number>();
	dependencies.set(from, outgoing);
	outgoing.set(to, (outgoing.get(to) ?? 0) + 1);
	return () => {
		const remaining = (outgoing.get(to) ?? 1) - 1;
		if (remaining) outgoing.set(to, remaining);
		else outgoing.delete(to);
		if (!outgoing.size) dependencies.delete(from);
	};
}

async function dispatchKernel(
	context: PythonHarnessContext,
	operation: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	assertSessionBridgeToolAvailable(context.session, "bash");
	const name = stringArg(args, "name");
	const owner =
		context.session.getEvalKernelOwnerId?.() ??
		context.session.getSessionId?.() ??
		context.session.sessionManager?.getSessionId();
	if (!owner) throw new Error("Named kernels require a stable host-owned session identity");
	const sessionId = namespaceSessionId(kernelLaneSessionId(context.session, name), "python:");
	const prior = getKernelLaneConfiguration(owner, "python", sessionId);
	const target =
		args.target === undefined ? (prior?.target ?? { kind: "local" as const }) : parseKernelTarget(args.target);
	const cwd = args.cwd === undefined ? (prior?.cwd ?? context.cwd) : stringArg(args, "cwd");
	if (
		args.env !== undefined &&
		(!isRecord(args.env) ||
			Object.entries(args.env).some(
				([key, value]) =>
					!key || key.includes("=") || key.includes("\0") || typeof value !== "string" || value.includes("\0"),
			))
	) {
		throw new Error("env must map valid environment names to strings without NUL");
	}
	const environment = args.env as Record<string, string> | undefined;
	const requestedInterpreter = args.interpreter === undefined ? prior?.interpreter : stringArg(args, "interpreter");
	const configuredCwd = target.kind === "local" ? path.resolve(context.cwd, cwd) : cwd;
	const interpreter =
		requestedInterpreter === undefined || target.kind !== "local"
			? requestedInterpreter
			: resolveExplicitPythonRuntime(
					requestedInterpreter,
					configuredCwd,
					environment ?? context.session.settings.getShellConfig().env,
				).pythonPath;
	const configuration = { cwd: configuredCwd, interpreter, target };
	const candidates = listPythonKernelSessions(owner).filter(item => item.sessionId === sessionId);
	if (args.interpreter === undefined && candidates.length > 1 && ["status", "stop", "restart"].includes(operation)) {
		throw new Error(`Ambiguous Python kernel name: ${name}; pass interpreter to choose one`);
	}
	const wanted =
		interpreter === undefined
			? undefined
			: target.kind === "local"
				? pythonEnvironmentIdentity(interpreter)
				: interpreter;
	const info = candidates.find(
		item =>
			item.cwd === configuration.cwd &&
			JSON.stringify(item.target) === JSON.stringify(target) &&
			(wanted === undefined ||
				(item.interpreter !== undefined &&
					(target.kind === "local" ? pythonEnvironmentIdentity(item.interpreter) : item.interpreter) === wanted)),
	);
	if (
		info &&
		prior &&
		operation !== "restart" &&
		(prior.cwd !== configuration.cwd || JSON.stringify(prior.target) !== JSON.stringify(configuration.target))
	) {
		throw new Error("Named kernel environment changed; restart explicitly before changing cwd/target");
	}
	if (operation === "status") return info ?? { name, state: "stopped", configured: prior ?? null };
	if (!["run", "exec", "stop", "restart"].includes(operation))
		throw new Error(`Unknown kernel operation: ${operation}`);
	const release = depend(context.kernelId ? `${owner}\0${context.kernelId}` : undefined, `${owner}\0${sessionId}`);
	try {
		if (operation === "stop" || operation === "restart") {
			if (info)
				await closePythonKernelSession(info.sessionKey, true, owner, operation === "restart" ? "reset" : "close");
			if (operation === "stop") {
				setKernelLaneConfiguration(owner, "python", sessionId, undefined);
				return { name, state: "stopped" };
			}
		}
		setKernelLaneConfiguration(owner, "python", sessionId, configuration);
		const runCwd = target.kind === "local" && args.cwd === undefined ? context.cwd : configuration.cwd;

		const emitStatus = (event: { op: string; [key: string]: unknown }) => {
			if (event.op === "kernel-state" && typeof event.generation === "string") {
				const identity = JSON.stringify([sessionId, configuration.cwd, interpreter ?? "", target]);
				const notice = observeKernelGeneration(context.session, identity, event.generation, `py:${name}`);
				if (notice) context.emit?.({ type: "status", event: { op: "note", text: `${notice}\n` } });
			}
			context.emit?.({ type: "status", event });
		};
		const options = {
			...configuration,
			sessionId,
			kernelOwnerId: owner,
			toolSession: context.session,
			signal: context.signal,
			runCwd,
			shellEnv: target.kind === "local" ? (args.env as Record<string, string> | undefined) : undefined,
			onBytes: context.onBytes,
			onDisplay: (output: EvalDisplayOutput) => {
				context.emit?.({ type: "display", output });
			},
			stdin:
				args.stdin === undefined
					? undefined
					: new ReadableStream<Uint8Array>({
							start(controller) {
								if (
									typeof args.stdin !== "string" ||
									!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(args.stdin)
								)
									throw new Error("stdin must be canonical base64");
								controller.enqueue(Buffer.from(args.stdin, "base64"));
								controller.close();
							},
						}),
			emitStatus,
			onStatus: emitStatus,
		};
		if (operation === "restart") return await startPythonKernelSession(options);
		const file = operation === "exec" ? stringArg(args, "file") : undefined;
		const code =
			file === undefined
				? typeof args.code === "string"
					? args.code
					: (() => {
							throw new Error("code must be a string");
						})()
				: `exec(compile(__import__("pathlib").Path(${JSON.stringify(file)}).read_bytes(), ${JSON.stringify(file)}, "exec"), globals())`;

		const result = await ExecutionAdmission.global().withWaitPermit(executionIdentity(context.session).nodeId, () =>
			executePython(code, { ...options, ...(file ? { invocation: { argv: [file], filename: file } } : {}) }),
		);
		if (result.cancelled && !context.signal.aborted) {
			const termination = takeKernelCellTermination(sessionId);
			if (termination) {
				const report = `py:${name} ${termination}; cell cancelled`;
				context.emit?.({
					type: "status",
					event: { op: "kernel-cell-termination", failure: `kernel ${report}`, text: `<kernel> ${report}\n` },
				});
			}
		}
		return result;
	} finally {
		release();
	}
}

/** The transport supplies every authority-bearing field; request data supplies none. */
export async function dispatchPythonHarnessRequest(
	context: PythonHarnessContext,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	context.signal.throwIfAborted();
	if (!resolveEvalBackends(context.session).python)
		throw new Error("Python harness APIs are disabled for this session");
	const options = bridgeOptions(context);
	if (
		name.startsWith("fs.") ||
		name.startsWith("kernel.") ||
		name.startsWith("store.") ||
		name === "display" ||
		name === "status"
	) {
		args = await authorizeSessionBridgeCall(name, args, options);
		if (name.startsWith("fs.")) return await dispatchFilesystem(context, name.slice(3), args);
		if (name.startsWith("kernel.")) return await dispatchKernel(context, name.slice(7), args);
		if (name.startsWith("store.")) return await dispatchPythonStoreRequest(context, name, args);
		if (name === "status") {
			context.emit?.({ type: "status", event: { ...args, op: stringArg(args, "op") } });
			return null;
		}
		if (!isRecord(args.bundle)) throw new Error("display bundle must be an object");
		const rendered = await renderKernelDisplay(args.bundle);
		if (rendered.text) context.emit?.({ type: "display", output: { type: "text", text: rendered.text } });
		for (const output of rendered.outputs) context.emit?.({ type: "display", output });
		return null;
	}
	if (name === "__completion__") {
		const { _completionInvocationId, ...input } = args;
		return await callSessionTool(name, input, {
			...options,
			completionInvocationId: typeof _completionInvocationId === "string" ? _completionInvocationId : undefined,
		});
	}
	return await callSessionTool(name, args, options);
}
