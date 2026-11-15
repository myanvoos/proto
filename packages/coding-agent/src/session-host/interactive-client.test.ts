import { describe, expect, test } from "bun:test";
import type { Terminal } from "@oh-my-pi/pi-tui";
import { parseArgs } from "../cli/args";
import type { DaemonBrokerClient } from "../launch/client";
import type { DaemonOperation, DaemonSnapshot } from "../launch/protocol";
import { interactiveHostArgs, interactiveHostRestartArgs, relayHostedTerminal } from "./interactive-client";

describe("interactive host selection handoff", () => {
	test("resumes the resolved transcript without repeating import, fork, cwd, or picker selection", () => {
		const forwarded = interactiveHostArgs(
			[
				"--fork",
				"source",
				"--resume=older",
				"--cwd",
				"/elsewhere",
				"--from-claude",
				"--continue",
				"--model",
				"test/model",
				"--trusted-extension",
				"/tmp/plugin.ts",
			],
			"/resolved/session.jsonl",
		);
		const parsed = parseArgs(forwarded);
		expect(parsed.resume).toBe("/resolved/session.jsonl");
		expect(parsed.fork).toBeUndefined();
		expect(parsed.cwd).toBeUndefined();
		expect(parsed.fromClaude).toBeUndefined();
		expect(parsed.continue).toBeUndefined();
		expect(parsed.model).toBe("test/model");
		expect(parsed.trustedExtensions).toEqual(["/tmp/plugin.ts"]);
	});

	test("does not strip a session-shaped token when it is another flag's value", () => {
		const parsed = parseArgs(
			interactiveHostArgs(
				["--append-system-prompt", "--resume", "--model=provider/model"],
				"/resolved/session.jsonl",
			),
		);
		expect(parsed.resume).toBe("/resolved/session.jsonl");
		expect(parsed.appendSystemPrompt).toBe("--resume");
		expect(parsed.model).toBe("provider/model");
	});

	test("preserves prompt text after the separator even when it resembles selection flags", () => {
		const parsed = parseArgs(
			interactiveHostArgs(["-r", "--", "--fork", "source", "--cwd=/prompt"], "/resolved/session.jsonl"),
		);
		expect(parsed.resume).toBe("/resolved/session.jsonl");
		expect(parsed.messages).toEqual(["--fork", "source", "--cwd=/prompt"]);
	});
});

describe("interactive restart argument capture", () => {
	test("restores persisted model and history without repeating startup selectors, messages, files, or separator text", () => {
		const parsed = parseArgs(
			interactiveHostRestartArgs(
				[
					"--resume",
					"/source.jsonl",
					"--provider",
					"original",
					"--model=initial",
					"--thinking",
					"high",
					"-m",
					"alias-model",
					"--config",
					"/config.json",
					"--trusted-extension",
					"/extension.ts",
					"--add-dir",
					"/workspace",
					"--no-skills",
					"initial submission",
					"@initial.txt",
					"--",
					"--model",
					"literal prompt",
				],
				"/active.jsonl",
			),
		);
		expect(parsed.resume).toBe("/active.jsonl");
		expect(parsed.provider).toBeUndefined();
		expect(parsed.model).toBeUndefined();
		expect(parsed.thinking).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(parsed.fileArgs).toEqual([]);
		expect(parsed.config).toEqual(["/config.json"]);
		expect(parsed.trustedExtensions).toEqual(["/extension.ts"]);
		expect(parsed.addDir).toEqual(["/workspace"]);
		expect(parsed.noSkills).toBe(true);
	});
	test("uses extension flag types so booleans never retain the following initial prompt as a value", () => {
		const flags = new Map<string, { type: "boolean" | "string" }>([
			["enable-audit", { type: "boolean" }],
			["audit-label", { type: "string" }],
		]);
		const parsed = parseArgs(
			interactiveHostRestartArgs(
				[
					"--enable-audit",
					"one-shot prompt",
					"--audit-label",
					"persistent label",
					"--unknown-toggle",
					"another prompt",
				],
				"/active.jsonl",
				flags,
			),
			flags,
		);
		expect(parsed.unknownFlags.get("enable-audit")).toBe(true);
		expect(parsed.unknownFlags.get("audit-label")).toBe("persistent label");
		expect(parsed.messages).toEqual([]);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});
	test("preserves flag-shaped string values but removes boolean inline values that the parser treats as initial messages", () => {
		const flags = new Map<string, { type: "boolean" | "string" }>([
			["audit", { type: "boolean" }],
			["label", { type: "string" }],
		]);
		const parsed = parseArgs(
			interactiveHostRestartArgs(
				["--append-system-prompt", "--model", "--audit=false", "--label=--provider", "--no-skills=true"],
				"/active.jsonl",
				flags,
			),
			flags,
		);
		expect(parsed.appendSystemPrompt).toBe("--model");
		expect(parsed.unknownFlags.get("audit")).toBe(true);
		expect(parsed.unknownFlags.get("label")).toBe("--provider");
		expect(parsed.messages).toEqual([]);
	});
});

describe("hosted terminal relay teardown", () => {
	/** Minimal terminal face: the relay only reads the size, writes output, and hands us its input hook. */
	function stubTerminal(): { terminal: Terminal; emitInput(data: string): void } {
		let onInput: ((data: string) => void) | undefined;
		const terminal = {
			columns: 100,
			rows: 40,
			kittyProtocolActive: false,
			kittyEnableSequence: null,
			pendingOutputBytes: 0,
			start(input: (data: string) => void) {
				onInput = input;
			},
			stop() {},
			drainInput: async () => {},
			write() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
			onAppearanceChange() {},
		} as unknown as Terminal;
		return { terminal, emitInput: data => onInput?.(data) };
	}

	const daemon = { name: "session-abc", id: "daemon-1" } as unknown as DaemonSnapshot;

	function stubClient(
		serve: (operation: DaemonOperation, signal?: AbortSignal) => Promise<unknown>,
	): DaemonBrokerClient & { attached: Promise<void> } {
		let attach!: () => void;
		const attached = new Promise<void>(resolve => {
			attach = resolve;
		});
		const request = (async (operation: DaemonOperation, signal?: AbortSignal) => {
			switch (operation.op) {
				case "terminal_attach":
					attach();
					return { op: "terminal_attach", daemon, terminalLeaseId: "lease", cursor: 0 };
				case "terminal_detach":
					return { op: "terminal_detach", daemon };
				default:
					return serve(operation, signal);
			}
		}) as DaemonBrokerClient["request"];
		return {
			projectDir: "/tmp/project",
			runtimeDir: "/tmp/run",
			onCompletion: () => () => {},
			close: () => {},
			ensureCapability: async () => {},
			request,
			attached,
		};
	}

	/** A read that parks until the attachment aborts, like the real broker's long poll. */
	function parkedRead(_operation: DaemonOperation, signal?: AbortSignal): Promise<unknown> {
		return new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
		});
	}

	test("a send rejected because the hosted daemon already exited finishes the attachment instead of failing it", async () => {
		const client = stubClient((operation, signal) => {
			if (operation.op === "send") return Promise.reject(new Error("Daemon session-abc is exited"));
			return parkedRead(operation, signal);
		});
		const { terminal, emitInput } = stubTerminal();
		const relayed = relayHostedTerminal(client, daemon, terminal);
		await client.attached;
		// The relay assigns its terminal lease right after the attach response resumes.
		await Bun.sleep(10);
		emitInput("\u0003");

		await expect(relayed).resolves.toBe("exited");
	});

	test("a send rejected for any other reason still surfaces as a failure", async () => {
		const client = stubClient((operation, signal) => {
			if (operation.op === "send") return Promise.reject(new Error("Terminal input exceeded its bounded queue"));
			return parkedRead(operation, signal);
		});
		const { terminal, emitInput } = stubTerminal();
		const relayed = relayHostedTerminal(client, daemon, terminal);
		await client.attached;
		await Bun.sleep(10);
		emitInput("x");

		await expect(relayed).rejects.toThrow("bounded queue");
	});

	test("a daemon that exits before the attachment lands reports an exited session", async () => {
		const client = stubClient(() => parkedRead({ op: "read" } as DaemonOperation));
		const { terminal } = stubTerminal();
		const failing = {
			...client,
			request: (async (operation: DaemonOperation) => {
				if (operation.op === "terminal_attach") throw new Error("Process has no live terminal to attach");
				return { op: "terminal_detach", daemon };
			}) as DaemonBrokerClient["request"],
		};
		await expect(relayHostedTerminal(failing, daemon, terminal)).resolves.toBe("exited");
	});
});
