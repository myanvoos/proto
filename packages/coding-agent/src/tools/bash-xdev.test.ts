import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Shell } from "@oh-my-pi/pi-natives";
import { formatBackgroundNotice } from "../async";
import { disposeBashSessions } from "../exec/bash-executor";
import type { Skill } from "../extensibility/skills";
import { initTheme, theme } from "../modes/theme/theme";
import type { Tool, ToolSession } from ".";
import { BashTool } from "./bash";
import { ContextTool } from "./context";
import { ReadTool } from "./read";
import { toolRenderers } from "./renderers";
import { ToolAbortError } from "./tool-errors";
import { resolveXdevTool } from "./xdev";

interface ProbeState {
	calls: string[];
	active: number;
	maxActive: number;
}

await initTheme(false, false, "proto");

function systemPromptsSkill(dir: string): Skill {
	return {
		name: "system-prompts",
		description: "test skill",
		filePath: path.join(dir, "system-prompts", "SKILL.md"),
		baseDir: path.join(dir, "system-prompts"),
		source: "builtin",
	};
}

function sessionWithProbe(
	cwd: string,
	state: ProbeState,
	skills: readonly Skill[] = [],
	activeNames: readonly string[] = [],
): ToolSession {
	const probe = {
		name: "probe",
		label: "Probe",
		description: "Returns the supplied value.",
		parameters: type({ value: "string" }),
		async execute(_toolCallId: string, args: { value: string }) {
			state.calls.push(args.value);
			state.active++;
			state.maxActive = Math.max(state.maxActive, state.active);
			await Bun.sleep(20);
			state.active--;
			return {
				content: [{ type: "text" as const, text: `probe:${args.value}\n` }],
				...(args.value === "fail" ? { isError: true } : {}),
				...(args.value === "structured" ? { details: { answer: 42, nested: { ready: false } } } : {}),
			};
		},
	} as unknown as Tool;
	const probe2 = {
		name: "probe2",
		label: "Probe Two",
		description: "Second probe tool for composite dispatch rendering.",
		parameters: type({ value: "string" }),
		async execute(_toolCallId: string, args: { value: string }) {
			state.calls.push(`probe2:${args.value}`);
			return { content: [{ type: "text" as const, text: `probe2:${args.value}\n` }] };
		},
	} as unknown as Tool;
	return {
		cwd,
		skills,
		settings: {
			get: () => undefined,
			getShellConfig: () => ({ env: {} }),
		},
		xdev: {
			tools: new Map([
				[probe.name, probe],
				[probe2.name, probe2],
			]),
			mountedNames: new Set([probe.name, probe2.name]),
			builtInNames: new Set([probe.name, probe2.name]),
			isActive: (name: string) => activeNames.includes(name),
		},
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

async function withBash(
	run: (bash: BashTool, state: ProbeState, session: ToolSession) => Promise<void>,
	activeNames: readonly string[] = [],
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	try {
		const session = sessionWithProbe(dir, state, [], activeNames);
		await run(new BashTool(session), state, session);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Render a settled bash result through the production renderer, mirroring tool-execution's render context. */
function renderBashResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	command: string,
	expanded: boolean,
	session?: ToolSession,
): string {
	const xdev = session?.xdev;
	// Mirrors tool-execution's render context.
	const resolveXdev = xdev ? (name: string) => resolveXdevTool(xdev, name) : undefined;
	const renderer = toolRenderers.bash as never as {
		renderResult: (r: unknown, o: unknown, t: unknown, a: unknown) => { render: (w: number) => string[] };
	};
	const component = renderer.renderResult(
		result,
		{ expanded, isPartial: false, renderContext: { expanded, resolveXdevTool: resolveXdev } },
		theme,
		{ command },
	);
	return stripAnsi(component.render(90).join("\n"));
}

test("protolens cannot reset its own lane and rejected control preserves shell state", async () => {
	await withBash(async (bash, _state, session) => {
		session.getSessionId = () => session.cwd;
		const context = new ContextTool(session);
		session.xdev!.tools.set("context", context);
		session.xdev!.mountedNames.add("context");
		try {
			const rejected = await bash.execute("self-reset", {
				command: "ORIGIN_MARKER=retained; protolens context --op reset --resource lane --lane work",
				lane: "work",
			});
			expect(rejected.details?.exitCode, textOf(rejected)).toBe(1);
			const next = await bash.execute("after-rejected-reset", {
				command: 'printf "%s" "$ORIGIN_MARKER"',
				lane: "work",
			});
			expect(next.isError).not.toBe(true);
			expect(textOf(next)).toContain("retained");
		} finally {
			await disposeBashSessions(session.cwd);
		}
	});
}, 10_000);

test("protolens is the only device builtin and proto remains an external executable", async () => {
	await withBash(async (bash, state, session) => {
		const executable = path.join(session.cwd, "proto");
		await fs.writeFile(executable, "#!/bin/sh\nprintf 'external-proto:%s\\n' \"$1\"\n", { mode: 0o755 });
		const result = await bash.execute("device-namespace", {
			command: `export PATH="$PWD:$PATH"; type -t protolens; type -t proto; proto --version; if type -t xd; then exit 99; fi; protolens probe --value mounted`,
		});
		expect(result.isError, textOf(result)).not.toBe(true);
		expect(textOf(result)).toContain("builtin\nfile\nexternal-proto:--version\n");
		expect(state.calls).toEqual(["mounted"]);
	});
});

test("multiple semicolon-separated protolens calls dispatch in order", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("protolens-sequential", {
			command: `protolens probe '{"value":"one"}'; protolens probe '{"value":"two"}'`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:one\nprobe:two\n");
		expect(state.calls).toEqual(["one", "two"]);
		expect(state.maxActive).toBe(1);
	});
});

test("protolens conditional chains preserve shell success semantics", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("protolens-conditional", {
			command: `protolens probe '{"value":"fail"}' && protolens probe '{"value":"skipped"}' || protolens probe '{"value":"recovered"}'`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:recovered\n");
		expect(textOf(result)).toContain("probe:fail\n");
		expect(state.calls).toEqual(["fail", "recovered"]);
	});
});

test("ampersand-separated protolens calls dispatch concurrently", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("protolens-concurrent", {
			command: `protolens probe '{"value":"one"}' & protolens probe '{"value":"two"}' & wait`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:one");
		expect(textOf(result)).toContain("probe:two");
		expect([...state.calls].sort()).toEqual(["one", "two"]);
		expect(state.maxActive).toBe(2);
	});
});

test("mixed native commands compose with protolens through Brush", async () => {
	await withBash(async bash => {
		const result = await bash.execute("protolens-mixed", {
			command: `protolens probe '{"value":"one"}'; printf done`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:one\n");
		expect(textOf(result)).toContain("done");
	});
});

test("protolens JSON string values keep internal URI literals opaque", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-opaque-uri-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	const uri = "skill" + "://system-prompts";
	const skills: Skill[] = [systemPromptsSkill(dir)];
	try {
		const bash = new BashTool(sessionWithProbe(dir, state, skills));
		const result = await bash.execute("protolens-opaque-uri", { command: `protolens probe '{"value":"${uri}"}'` });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain(`probe:${uri}\n`);
		expect(state.calls).toEqual([uri]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("protolens JSON with shell-escaped quotes stays opaque", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-escaped-uri-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	const uri = "skill" + "://system-prompts";
	try {
		const bash = new BashTool(sessionWithProbe(dir, state, [systemPromptsSkill(dir)]));
		const json = `{\\"value\\":\\"${uri}\\"}`;
		const result = await bash.execute("protolens-escaped-uri", { command: `protolens probe ${json}` });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain(`probe:${uri}\n`);
		expect(state.calls).toEqual([uri]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("protolens JSON supplied through an environment variable stays opaque", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-env-uri-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	const uri = "skill" + "://system-prompts";
	try {
		const bash = new BashTool(sessionWithProbe(dir, state, [systemPromptsSkill(dir)]));
		const result = await bash.execute("protolens-env-uri", {
			command: 'protolens probe "$ARGS"',
			env: { ARGS: `{"value":"${uri}"}` },
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain(`probe:${uri}\n`);
		expect(state.calls).toEqual([uri]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("protolens accepts extra MCP arguments when the input schema is open", async () => {
	await withBash(async (bash, _state, session) => {
		const makeTool = (name: string, additionalProperties?: unknown): Tool => {
			const parameters = {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				...(additionalProperties === undefined ? {} : { additionalProperties }),
			};
			return {
				name,
				label: name,
				description: "Accepts open MCP arguments.",
				parameters,
				async execute(_toolCallId: string, args: Record<string, unknown>) {
					return { content: [{ type: "text" as const, text: `accepted:${String(args.extra)}\n` }] };
				},
			} as unknown as Tool;
		};
		const omitted = makeTool("mcp-open");
		const schemaObject = makeTool("mcp-schema-open", { type: "string" });
		session.xdev?.tools.set(omitted.name, omitted);
		session.xdev?.tools.set(schemaObject.name, schemaObject);
		session.xdev?.mountedNames.add(omitted.name);
		session.xdev?.mountedNames.add(schemaObject.name);

		for (const name of [omitted.name, schemaObject.name]) {
			const result = await bash.execute(`protolens-open-${name}`, {
				command: `protolens ${name} '{"value":"ok","extra":"forwarded"}'`,
			});
			expect(result.isError).not.toBe(true);
			expect(textOf(result)).toContain("accepted:forwarded\n");
		}
	});
});

test("protolens refuses the bash transport instead of recursively executing it", async () => {
	await withBash(
		async (bash, _state, session) => {
			let nestedCalls = 0;
			const nestedBash = {
				name: "bash",
				label: "Bash",
				description: "Nested bash should never run through protolens.",
				parameters: type({ command: "string" }),
				async execute() {
					nestedCalls++;
					return { content: [{ type: "text" as const, text: "nested bash ran\n" }] };
				},
			} as unknown as Tool;
			session.xdev?.tools.set("bash", nestedBash);
			const result = await bash.execute("protolens-bash-transport", {
				command: `protolens bash '{"command":"echo nested"}'`,
			});
			expect(nestedCalls).toBe(0);
			expect(textOf(result)).toContain("No such tool: protolens://bash.");
		},
		["bash"],
	);
});

test("protolens preserves text block boundaries for shell output and rendering", async () => {
	await withBash(async (bash, _state, session) => {
		const multi = {
			name: "multi-block",
			label: "Multi block",
			description: "Returns two text blocks.",
			parameters: type({}),
			async execute() {
				return {
					content: [
						{ type: "text" as const, text: "first" },
						{ type: "text" as const, text: "second" },
					],
				};
			},
		} as unknown as Tool;
		session.xdev?.tools.set(multi.name, multi);
		session.xdev?.mountedNames.add(multi.name);
		const command = `protolens ${multi.name} '{}'`;
		const result = await bash.execute("protolens-block-boundary", { command });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("first\nsecond\n");
		expect(textOf(result)).not.toContain("firstsecond");

		const rendered = renderBashResult(result, command, false, session);
		const normalizedRendered = rendered
			.split("\n")
			.map(line => line.trim())
			.join("\n");
		expect(normalizedRendered).toContain("first\nsecond");
		expect(normalizedRendered).not.toContain("firstsecond");
	});
});

test("protolens keeps tool output when dispatch details are not JSON serializable", async () => {
	await withBash(async (bash, _state, session) => {
		const bigint = {
			name: "bigint-details",
			label: "BigInt details",
			description: "Returns output with a BigInt detail.",
			parameters: type({}),
			async execute() {
				return {
					content: [{ type: "text" as const, text: "output survived\n" }],
					details: { payload: 1n },
				};
			},
		} as unknown as Tool;
		session.xdev?.tools.set(bigint.name, bigint);
		session.xdev?.mountedNames.add(bigint.name);
		const result = await bash.execute("protolens-bigint-details", { command: `protolens ${bigint.name} '{}'` });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("output survived\n");
	});
});

test("standalone command and environment path URIs still resolve", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-path-uri-"));
	const skillDir = path.join(dir, "system-prompts");
	await fs.mkdir(skillDir);
	await fs.writeFile(path.join(skillDir, "marker.txt"), "marker\n");
	const uri = "skill" + "://system-prompts/marker.txt";
	try {
		const bash = new BashTool(
			sessionWithProbe(dir, { calls: [], active: 0, maxActive: 0 }, [systemPromptsSkill(dir)]),
		);
		const direct = await bash.execute("standalone-uri", { command: `cat ${uri}` });
		const viaEnv = await bash.execute("standalone-env-uri", {
			command: 'cat "$TARGET"',
			env: { TARGET: uri },
		});
		expect(textOf(direct)).toContain("marker\n");
		expect(textOf(viaEnv)).toContain("marker\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("protolens receives generated-view URIs as typed while other commands still reject them", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("protolens-generated-view", {
			command:
				'protolens probe history://worker_0:1-5 && FOO=1 protolens probe agent://worker_0; echo "$(protolens probe history://)"',
		});
		expect(result.isError, textOf(result)).not.toBe(true);
		expect(state.calls).toEqual(["history://worker_0:1-5", "agent://worker_0", "history://"]);
		await expect(
			bash.execute("cat-generated-view", { command: "protolens probe ok; cat agent://worker_0" }),
		).rejects.toThrow("generated view");
	});
});

test("protolens stdout participates in native pipelines and substitutions", async () => {
	await withBash(async bash => {
		const piped = await bash.execute("protolens-pipe", {
			command: `protolens probe '{"value":"pipe"}' | rg '^probe:'`,
		});
		expect(piped.isError).not.toBe(true);
		expect(textOf(piped)).toContain("probe:pipe\n");

		const substituted = await bash.execute("protolens-substitution", {
			command: `value=$(protolens probe '{"value":"sub"}'); printf '<%s>' "$value"`,
		});
		expect(substituted.isError).not.toBe(true);
		expect(textOf(substituted)).toContain("<probe:sub>");
	});
});

test("protolens redirects and pipeline status use the native shell", async () => {
	await withBash(async (bash, state) => {
		const outPath = `${state.calls.length}-protolens-output.txt`;
		const redirected = await bash.execute("protolens-redirect", {
			command: `protolens probe '{"value":"redirect"}' > ${outPath}; cat ${outPath}`,
		});
		expect(redirected.isError).not.toBe(true);
		expect(textOf(redirected)).toContain("probe:redirect\n");

		// Pipeline status is computed natively; exit 2 is a hard failure, while
		// exit 1 is the soft Unix signal and stays a data result.
		const failed = await bash.execute("protolens-pipe-failure", {
			command: `protolens probe '{"value":"closed"}' | exit 2`,
		});
		expect(failed.isError).toBe(true);
		const soft = await bash.execute("protolens-pipe-soft", {
			command: `protolens probe '{"value":"closed"}' | exit 1`,
		});
		expect(soft.isError ?? false).toBe(false);
	});
});

test("piped stdin supplies the protolens JSON args when no positional args are given", async () => {
	await withBash(async (bash, state) => {
		const piped = await bash.execute("protolens-stdin", {
			command: `printf '{"value":"from-stdin"}' | protolens probe`,
		});
		expect(piped.isError).not.toBe(true);
		expect(textOf(piped)).toContain("probe:from-stdin\n");
		const chained = await bash.execute("protolens-stdin-chain", {
			command: `protolens probe '{"value":"first"}' | sed 's/^probe:\\(.*\\)$/{"value":"\\1-again"}/' | protolens probe`,
		});
		expect(textOf(chained)).toContain("probe:first-again\n");
		const explicit = await bash.execute("protolens-stdin-ignored", {
			command: `printf '{"value":"stdin"}' | protolens probe '{"value":"arg"}'`,
		});
		expect(textOf(explicit)).toContain("probe:arg\n");
		const invalid = await bash.execute("protolens-stdin-invalid", {
			command: `printf 'nope' | protolens probe; echo rc=$?`,
		});
		expect(textOf(invalid)).toContain("piped stdin must be a JSON args object");
		expect(textOf(invalid)).toContain("rc=2");
		expect(state.calls).toEqual(["from-stdin", "first", "first-again", "arg"]);
	});
});

test("protolens text output is newline-terminated so following commands start on their own line", async () => {
	await withBash(async bash => {
		const docs = await bash.execute("protolens-docs-newline", { command: `protolens probe ?; printf next` });
		expect(textOf(docs)).toContain("for these docs).\nJSON escape hatch:");
		const failure = await bash.execute("protolens-error-newline", { command: `protolens missing '{}'; printf next` });
		expect(textOf(failure)).toContain("No such tool: protolens://missing.");
		expect(textOf(failure)).toMatch(/protolens:\/\/<tool>\.\nnext/);
	});
});

test("mounted read uses pipelines and branch-local cwd", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-read-"));
	await fs.mkdir(path.join(dir, "one"));
	await fs.mkdir(path.join(dir, "two"));
	await fs.writeFile(path.join(dir, "one", "same.txt"), "ONE\n");
	await fs.writeFile(path.join(dir, "two", "same.txt"), "TWO\n");
	const values: Record<string, unknown> = {
		"images.autoResize": false,
		"read.defaultLimit": 200,
		"fetch.enabled": false,
		"bashInterceptor.enabled": false,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"kernel.speculation.enabled": false,
		"kernel.assertPreflight.enabled": false,
		"bash.direnv": "off",
		"tools.maxTimeout": 300,
	};
	const session = {
		cwd: dir,
		settings: { get: (key: string) => values[key], getShellConfig: () => ({ env: {} }) },
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "bash-xdev-read",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
	const read = new ReadTool(session);
	session.xdev = {
		tools: new Map([["read", read]]),
		mountedNames: new Set(["read"]),
		builtInNames: new Set(["read"]),
		isActive: () => false,
	};
	try {
		const bash = new BashTool(session);
		const piped = await bash.execute("protolens-read-pipe", {
			command: `(cd one; protolens read '{"path":"same.txt"}') | rg ONE`,
		});
		expect(piped.isError).not.toBe(true);
		expect(textOf(piped)).toContain("ONE");
		const branches = await bash.execute("protolens-read-branches", {
			command: `(cd one; protolens read '{"path":"same.txt"}') & (cd two; protolens read '{"path":"same.txt"}') & wait`,
		});
		expect(branches.isError).not.toBe(true);
		expect(textOf(branches)).toContain("ONE");
		expect(textOf(branches)).toContain("TWO");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

interface CancellationProbeState {
	calls: number;
	started: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
	ignoreSignal: boolean;
	aborted: PromiseWithResolvers<void>;
}

function sessionWithCancellationProbe(cwd: string, state: CancellationProbeState): ToolSession {
	const probe = {
		name: "probe",
		label: "Probe",
		description: "Blocks until released.",
		parameters: type({ value: "string" }),
		async execute(_toolCallId: string, args: { value: string }, signal?: AbortSignal) {
			state.calls++;
			state.started.resolve();
			if (state.ignoreSignal) {
				await state.release.promise;
			} else {
				await Promise.race([
					state.release.promise,
					new Promise<never>((_resolve, reject) => {
						if (signal?.aborted) {
							state.aborted.resolve();
							reject(new ToolAbortError("probe aborted"));
							return;
						}
						signal?.addEventListener(
							"abort",
							() => {
								state.aborted.resolve();
								reject(new ToolAbortError("probe aborted"));
							},
							{ once: true },
						);
					}),
				]);
			}
			return { content: [{ type: "text" as const, text: `probe:${args.value}\n` }] };
		},
	} as unknown as Tool;
	return {
		cwd,
		settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
		xdev: {
			tools: new Map([[probe.name, probe]]),
			mountedNames: new Set([probe.name]),
			builtInNames: new Set([probe.name]),
			isActive: () => false,
		},
	} as unknown as ToolSession;
}

test("pre-aborted protolens calls never invoke the mounted tool", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-abort-"));
	const state: CancellationProbeState = {
		calls: 0,
		started: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		ignoreSignal: false,
		aborted: Promise.withResolvers<void>(),
	};
	try {
		const bash = new BashTool(sessionWithCancellationProbe(dir, state));
		const controller = new AbortController();
		controller.abort();
		await expect(
			bash.execute("protolens-pre-abort", { command: `protolens probe '{"value":"never"}'` }, controller.signal),
		).rejects.toThrow();
		expect(state.calls).toBe(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("protolens cooperative cancellation propagates the signal and discards output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-coop-"));
	const state: CancellationProbeState = {
		calls: 0,
		started: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		ignoreSignal: false,
		aborted: Promise.withResolvers<void>(),
	};
	try {
		const bash = new BashTool(sessionWithCancellationProbe(dir, state));
		const controller = new AbortController();
		const pending = bash.execute(
			"protolens-cooperative-abort",
			{ command: `protolens probe '{"value":"cooperative"}'` },
			controller.signal,
		);
		await state.started.promise;
		controller.abort();
		state.release.resolve();
		await expect(pending).rejects.toThrow();
		expect(state.calls).toBe(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("protolens late results are discarded after cancellation", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-late-"));
	const state: CancellationProbeState = {
		calls: 0,
		started: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		ignoreSignal: true,
		aborted: Promise.withResolvers<void>(),
	};
	try {
		const bash = new BashTool(sessionWithCancellationProbe(dir, state));
		const controller = new AbortController();
		const pending = bash.execute(
			"protolens-late-abort",
			{ command: `protolens probe '{"value":"late"}'` },
			controller.signal,
		);
		await state.started.promise;
		controller.abort();
		state.release.resolve();
		await expect(pending).rejects.toThrow();
		expect(state.calls).toBe(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("the shell deadline aborts an in-flight protolens dispatch instead of orphaning it", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-deadline-"));
	const state: CancellationProbeState = {
		calls: 0,
		started: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		ignoreSignal: false,
		aborted: Promise.withResolvers<void>(),
	};
	try {
		const bash = new BashTool(sessionWithCancellationProbe(dir, state));
		const result = await bash.execute("protolens-deadline", {
			command: `protolens probe '{"value":"deadline"}'`,
			timeout: 1,
		});
		expect(result.isError).toBe(true);
		expect(result.details?.timedOut).toBe(true);
		expect(result.details?.execution?.timeout).toMatchObject({ cause: "deadline", scope: "command" });
		await state.aborted.promise;
		expect(state.calls).toBe(1);
	} finally {
		state.release.resolve();
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 15000);

test("native protolens bridge keeps stdin and pipe purity separate from status records", async () => {
	const shell = new Shell();
	const chunks: string[] = [];
	let request: { stdin?: string } | undefined;
	const result = await shell.run(
		{
			command: "printf input | protolens probe | rg '^out$'",
			cwd: process.cwd(),
			protolensCallId: "protolens-stream",
		},
		(error, chunk) => {
			if (!error) chunks.push(chunk);
		},
		async raw => {
			request = JSON.parse(raw) as { stdin?: string };
			return JSON.stringify({ stdout: "out\n", stderr: "not-piped\n", exitCode: 0, record: '{"kind":"probe"}' });
		},
	);
	expect(request?.stdin).toBe("input");
	expect(chunks.join("")).toContain("out\n");
	expect(chunks.join("")).toContain("not-piped");
	expect(result.exitCode).toBe(0);
	expect(result.protolensDispatches).toEqual(['{"kind":"probe"}']);

	const stderrOnly = await new Shell().run(
		{
			command: "printf input | protolens probe | rg '^not-piped$'",
			cwd: process.cwd(),
			protolensCallId: "protolens-stderr",
		},
		undefined,
		async () => JSON.stringify({ stdout: "out\n", stderr: "not-piped\n", exitCode: 0, record: "{}" }),
	);
	expect(stderrOnly.exitCode).toBe(1);
});

test("protolens help keeps full docs for the model but renders a compact card in TUI", async () => {
	await withBash(async (bash, _state, session) => {
		const result = await bash.execute("protolens-help", { command: `protolens probe ?` });
		expect(result.isError).not.toBe(true);

		// Model-facing content is untouched: full description + schema.
		const modelText = textOf(result);
		expect(modelText).toContain("Returns the supplied value.");
		expect(modelText).toContain("type Args");

		const rendered = renderBashResult(result, `protolens probe ?`, false, session);
		expect(rendered).toContain("protolens://probe · docs");
		expect(rendered).toContain("Returns the supplied value.");
		expect(rendered).toContain("1 arg");
		expect(rendered).toContain("required: value");
		// Collapsed card must not dump the full instruction block into the TUI.
		expect(rendered).not.toContain("type Args");
		expect(rendered).not.toContain("## Schema");
	});
});

test("protolens help card keeps the device description when a transport notice precedes the docs", async () => {
	await withBash(async (bash, _state, session) => {
		const result = await bash.execute("protolens-help-notice", { command: `protolens probe ?` });
		expect(result.isError).not.toBe(true);
		const noticed = {
			...result,
			content: result.content.map(part =>
				part.type === "text"
					? { ...part, text: `<shell> state lost: lane main shell was killed by a timeout.\n${part.text}` }
					: part,
			),
		};
		const rendered = renderBashResult(noticed, `protolens probe ?`, false, session);
		expect(rendered).toContain("protolens://probe · docs");
		expect(rendered).toContain("Returns the supplied value.");
	});
});

test("protolens help card expands to the full docs", async () => {
	await withBash(async bash => {
		const result = await bash.execute("protolens-help-expanded", { command: `protolens probe ?` });
		expect(result.isError).not.toBe(true);
		const rendered = renderBashResult(result, `protolens probe ?`, true);
		expect(rendered).toContain("protolens://probe · docs");
		expect(rendered).toContain("type Args");
		expect(rendered).toContain("usage: protolens probe <value>");
		expect(rendered).toContain("Execute from bash");
	});
});

test("chained protolens help calls render one status line per device, not a docs dump", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `protolens probe ?; protolens probe2 ?`;
		const result = await bash.execute("protolens-composite-help", { command });
		expect(result.isError).not.toBe(true);

		const modelText = textOf(result);
		expect(modelText).toContain("Returns the supplied value.");
		expect(modelText).toContain("Second probe tool for composite dispatch rendering.");
		expect(modelText).toContain("type Args");

		const rendered = renderBashResult(result, command, false, session);
		expect(rendered).toContain("protolens://probe · docs");
		expect(rendered).toContain("protolens://probe2 · docs");
		expect(rendered).not.toContain("type Args");
		expect(rendered).toContain("expand");
	});
});

test("protolens mixed with other commands renders the shell card with the full command", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `printf hi; protolens probe ?`;
		const result = await bash.execute("protolens-composite-mixed", { command });
		expect(result.isError).not.toBe(true);
		const rendered = renderBashResult(result, command, true, session);
		expect(rendered).toContain(`$ ${command}`);
		expect(rendered).toContain("hi");
	});
});

test("chained protolens execute calls render one line per dispatch with their output", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `protolens probe '{"value":"one"}'; protolens probe '{"value":"two"}'`;
		const result = await bash.execute("protolens-composite-execute", { command });
		expect(result.isError).not.toBe(true);
		const rendered = renderBashResult(result, command, false, session);
		// Each device gets its own section: a header naming the invocation, then that device's output.
		const lines = rendered.split("\n").map(line => line.trim());
		const oneHeader = lines.findIndex(line => line.includes("protolens://probe: --value one"));
		const twoHeader = lines.findIndex(line => line.includes("protolens://probe: --value two"));
		expect(oneHeader).toBeGreaterThanOrEqual(0);
		expect(lines[oneHeader + 1]).toBe("probe:one");
		expect(twoHeader).toBe(oneHeader + 2);
		expect(lines[twoHeader + 1]).toBe("probe:two");
	});
});

test("piped protolens output renders the merged shell output, not per-device sections", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `protolens probe '{"value":"one"}' | tr a-z A-Z; protolens probe '{"value":"two"}'`;
		const result = await bash.execute("protolens-composite-piped", { command });
		expect(result.isError).not.toBe(true);
		const rendered = renderBashResult(result, command, false, session);
		expect(rendered).toContain("PROBE:ONE");
		expect(rendered).not.toContain("probe:one");
	});
});

test("protolens rejects unknown top-level keys without appending schema docs", async () => {
	await withBash(async bash => {
		const result = await bash.execute("protolens-unknown-key", {
			command: `protolens probe '{"value":"ok","ids":["worker-1"]}'`,
		});
		const output = textOf(result);
		expect(output).toContain("unknown top-level key: ids");
		expect(output).toContain("Accepted keys: value");
		expect(output).not.toContain("## Schema");
	});
});

test("protolens validation failures append only the schema block", async () => {
	await withBash(async bash => {
		const result = await bash.execute("protolens-schema-error", {
			command: `protolens probe '{"value":null}'`,
		});
		const output = textOf(result);
		expect(output).toContain("## Schema");
		expect(output).toContain("type Args =");
		expect(output).not.toContain("Returns the supplied value");
	});
});

test("failed protolens dispatches are flagged in composite cards", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `protolens probe '{"value":"fail"}'; protolens probe '{"value":"ok"}'`;
		const result = await bash.execute("protolens-composite-failure", { command });
		const rendered = renderBashResult(result, command, false, session);
		const errorGlyph = stripAnsi(theme.styledSymbol("status.error", "error"));
		const doneGlyph = stripAnsi(theme.styledSymbol("status.done", "success"));
		expect(rendered).toContain(`${errorGlyph} protolens://probe`);
		expect(rendered).toContain(`${doneGlyph} protolens://probe`);
		expect(rendered).toContain("probe:fail");
		expect(rendered).toContain("probe:ok");
	});
});

test("a backgrounded command renders as pending, not failed", () => {
	const jobId = "bg_1";
	const result = {
		content: [{ type: "text", text: formatBackgroundNotice(jobId) }],
		details: {
			execution: { state: "running", collector: { state: "complete" }, output: { disposition: "unavailable" } },
			async: { state: "running", jobId, type: "bash" },
		},
	};
	const rendered = renderBashResult(result, "sleep 30", false);
	expect(rendered).not.toContain("failed");
	expect(rendered).toContain(`Backgrounded: ${jobId}`);
});

test("protolens CLI flags dispatch through the schema without JSON quoting", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("protolens-cli-flags", { command: `protolens probe --value one` });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:one\n");
		expect(state.calls).toEqual(["one"]);

		const mixed = await bash.execute("protolens-cli-positional", { command: `protolens probe two` });
		expect(textOf(mixed)).toContain("probe:two\n");
		expect(state.calls).toEqual(["one", "two"]);
	});
});

test("protolens CLI usage failures exit 2 while tool failures exit 1", async () => {
	await withBash(async bash => {
		const usage = await bash.execute("protolens-usage-exit", { command: `protolens probe --vale x; echo rc=$?` });
		expect(textOf(usage)).toContain("unknown flag --vale (did you mean --value?)");
		expect(textOf(usage)).toContain("rc=2");

		const missing = await bash.execute("protolens-missing-value-exit", {
			command: `protolens probe --value; echo rc=$?`,
		});
		expect(textOf(missing)).toContain("needs a value");
		expect(textOf(missing)).toContain("rc=2");

		const toolFailure = await bash.execute("protolens-tool-exit", {
			command: `protolens probe '{"value":"fail"}'; echo rc=$?`,
		});
		expect(textOf(toolFailure)).toContain("rc=1");
	});
});

test("a device without its own renderer shows the typed invocation and its output", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `protolens probe --value cli`;
		const result = await bash.execute("protolens-cli-render", { command });
		const lines = renderBashResult(result, command, false, session)
			.split("\n")
			.map(line => line.trim());
		const header = lines.findIndex(line => line.includes("protolens://probe: --value cli"));
		expect(header).toBeGreaterThanOrEqual(0);
		expect(lines[header + 1]).toBe("probe:cli");
	});
});

test("a failed single device call renders its error under a failed device header, without exit notices", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `protolens probe --value fail`;
		const result = await bash.execute("protolens-single-failure", { command });
		const rendered = renderBashResult(result, command, true, session);
		const errorGlyph = stripAnsi(theme.styledSymbol("status.error", "error"));
		expect(rendered).toContain(`${errorGlyph} protolens://probe: --value fail`);
		expect(rendered).toContain("probe:fail");
		expect(rendered).not.toContain("exited with code");
	});
});

test("a usage error renders under the rejected device's header", async () => {
	await withBash(async (bash, _state, session) => {
		const command = `protolens probe --bogus x`;
		const result = await bash.execute("protolens-usage-error", { command });
		const rendered = renderBashResult(result, command, false, session);
		const errorGlyph = stripAnsi(theme.styledSymbol("status.error", "error"));
		expect(rendered).toContain(`${errorGlyph} protolens://probe: --bogus x`);
		expect(rendered).toContain("unknown flag --bogus");
	});
});

test("bare protolens renders the device listing as one row per device", async () => {
	await withBash(async (bash, _state, session) => {
		const result = await bash.execute("protolens-listing", { command: "protolens" });
		const lines = renderBashResult(result, "protolens", false, session)
			.split("\n")
			.map(line => line.trim());
		expect(lines.some(line => line.includes("protolens://") && line.includes("2 devices"))).toBe(true);
		expect(lines.some(line => /^probe\s+Returns the supplied value/.test(line))).toBe(true);
		expect(lines.some(line => /^probe2\s+Second probe tool/.test(line))).toBe(true);
	});
});

test("device results retain typed payloads outside pipelines and correlate to native stages", async () => {
	await withBash(async bash => {
		const result = await bash.execute("device-record", {
			command: `protolens probe --json '{"value":"structured"}' | cat`,
		});
		const device = result.details?.deviceResults?.[0];
		expect(device?.stageIndex).toBeNumber();
		expect(device?.xdev).toMatchObject({ tool: "probe", inner: { answer: 42, nested: { ready: false } } });
		expect(result.details?.execution?.stages?.[device!.stageIndex!]?.route).toBe("protolens");
		expect(textOf(result)).toContain("probe:structured");
	});
});
