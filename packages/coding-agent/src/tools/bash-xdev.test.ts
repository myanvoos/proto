import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Shell } from "@oh-my-pi/pi-natives";
import type { Skill } from "../extensibility/skills";
import type { Tool, ToolSession } from ".";
import { BashTool } from "./bash";
import { ReadTool } from "./read";
import { ToolAbortError } from "./tool-errors";

interface ProbeState {
	calls: string[];
	active: number;
	maxActive: number;
}

function systemPromptsSkill(dir: string): Skill {
	return {
		name: "system-prompts",
		description: "test skill",
		filePath: path.join(dir, "system-prompts", "SKILL.md"),
		baseDir: path.join(dir, "system-prompts"),
		source: "builtin",
	};
}

function sessionWithProbe(cwd: string, state: ProbeState, skills: readonly Skill[] = []): ToolSession {
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
			};
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
			tools: new Map([[probe.name, probe]]),
			mountedNames: new Set([probe.name]),
			builtInNames: new Set([probe.name]),
			isActive: () => false,
		},
	} as unknown as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

async function withBash(run: (bash: BashTool, state: ProbeState) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	try {
		await run(new BashTool(sessionWithProbe(dir, state)), state);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("multiple semicolon-separated xd calls dispatch in order", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("xd-sequential", {
			command: `xd probe '{"value":"one"}'; xd probe '{"value":"two"}'`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:one\nprobe:two\n");
		expect(state.calls).toEqual(["one", "two"]);
		expect(state.maxActive).toBe(1);
	});
});

test("xd conditional chains preserve shell success semantics", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("xd-conditional", {
			command: `xd probe '{"value":"fail"}' && xd probe '{"value":"skipped"}' || xd probe '{"value":"recovered"}'`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:recovered\n");
		expect(textOf(result)).toContain("probe:fail\n");
		expect(state.calls).toEqual(["fail", "recovered"]);
	});
});

test("ampersand-separated xd calls dispatch concurrently", async () => {
	await withBash(async (bash, state) => {
		const result = await bash.execute("xd-concurrent", {
			command: `xd probe '{"value":"one"}' & xd probe '{"value":"two"}' & wait`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:one");
		expect(textOf(result)).toContain("probe:two");
		expect([...state.calls].sort()).toEqual(["one", "two"]);
		expect(state.maxActive).toBe(2);
	});
});

test("mixed native commands compose with xd through Brush", async () => {
	await withBash(async bash => {
		const result = await bash.execute("xd-mixed", { command: `xd probe '{"value":"one"}'; printf done` });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("probe:one\n");
		expect(textOf(result)).toContain("done");
	});
});

test("xd JSON string values keep internal URI literals opaque", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-opaque-uri-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	const uri = "skill" + "://system-prompts";
	const skills: Skill[] = [systemPromptsSkill(dir)];
	try {
		const bash = new BashTool(sessionWithProbe(dir, state, skills));
		const result = await bash.execute("xd-opaque-uri", { command: `xd probe '{"value":"${uri}"}'` });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain(`probe:${uri}\n`);
		expect(state.calls).toEqual([uri]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("xd JSON with shell-escaped quotes stays opaque", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-escaped-uri-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	const uri = "skill" + "://system-prompts";
	try {
		const bash = new BashTool(sessionWithProbe(dir, state, [systemPromptsSkill(dir)]));
		const json = `{\\"value\\":\\"${uri}\\"}`;
		const result = await bash.execute("xd-escaped-uri", { command: `xd probe ${json}` });
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain(`probe:${uri}\n`);
		expect(state.calls).toEqual([uri]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("xd JSON supplied through an environment variable stays opaque", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-env-uri-"));
	const state: ProbeState = { calls: [], active: 0, maxActive: 0 };
	const uri = "skill" + "://system-prompts";
	try {
		const bash = new BashTool(sessionWithProbe(dir, state, [systemPromptsSkill(dir)]));
		const result = await bash.execute("xd-env-uri", {
			command: 'xd probe "$ARGS"',
			env: { ARGS: `{"value":"${uri}"}` },
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain(`probe:${uri}\n`);
		expect(state.calls).toEqual([uri]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
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

test("xd stdout participates in native pipelines and substitutions", async () => {
	await withBash(async bash => {
		const piped = await bash.execute("xd-pipe", { command: `xd probe '{"value":"pipe"}' | rg '^probe:'` });
		expect(piped.isError).not.toBe(true);
		expect(textOf(piped)).toContain("probe:pipe\n");

		const substituted = await bash.execute("xd-substitution", {
			command: `value=$(xd probe '{"value":"sub"}'); printf '<%s>' "$value"`,
		});
		expect(substituted.isError).not.toBe(true);
		expect(textOf(substituted)).toContain("<probe:sub>");
	});
});

test("xd redirects and pipeline status use the native shell", async () => {
	await withBash(async (bash, state) => {
		const outPath = `${state.calls.length}-xd-output.txt`;
		const redirected = await bash.execute("xd-redirect", {
			command: `xd probe '{"value":"redirect"}' > ${outPath}; cat ${outPath}`,
		});
		expect(redirected.isError).not.toBe(true);
		expect(textOf(redirected)).toContain("probe:redirect\n");

		const failed = await bash.execute("xd-pipe-failure", { command: `xd probe '{"value":"closed"}' | false` });
		expect(failed.isError).toBe(true);
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
		const piped = await bash.execute("xd-read-pipe", {
			command: `(cd one; xd read '{"path":"same.txt"}') | rg ONE`,
		});
		expect(piped.isError).not.toBe(true);
		expect(textOf(piped)).toContain("ONE");
		const branches = await bash.execute("xd-read-branches", {
			command: `(cd one; xd read '{"path":"same.txt"}') & (cd two; xd read '{"path":"same.txt"}') & wait`,
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
							reject(new ToolAbortError("probe aborted"));
							return;
						}
						signal?.addEventListener("abort", () => reject(new ToolAbortError("probe aborted")), { once: true });
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

test("pre-aborted xd calls never invoke the mounted tool", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-abort-"));
	const state: CancellationProbeState = {
		calls: 0,
		started: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		ignoreSignal: false,
	};
	try {
		const bash = new BashTool(sessionWithCancellationProbe(dir, state));
		const controller = new AbortController();
		controller.abort();
		await expect(
			bash.execute("xd-pre-abort", { command: `xd probe '{"value":"never"}'` }, controller.signal),
		).rejects.toThrow();
		expect(state.calls).toBe(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("xd cooperative cancellation propagates the signal and discards output", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-coop-"));
	const state: CancellationProbeState = {
		calls: 0,
		started: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		ignoreSignal: false,
	};
	try {
		const bash = new BashTool(sessionWithCancellationProbe(dir, state));
		const controller = new AbortController();
		const pending = bash.execute(
			"xd-cooperative-abort",
			{ command: `xd probe '{"value":"cooperative"}'` },
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

test("xd late results are discarded after cancellation", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-xdev-late-"));
	const state: CancellationProbeState = {
		calls: 0,
		started: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		ignoreSignal: true,
	};
	try {
		const bash = new BashTool(sessionWithCancellationProbe(dir, state));
		const controller = new AbortController();
		const pending = bash.execute("xd-late-abort", { command: `xd probe '{"value":"late"}'` }, controller.signal);
		await state.started.promise;
		controller.abort();
		state.release.resolve();
		await expect(pending).rejects.toThrow();
		expect(state.calls).toBe(1);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("native xd bridge keeps stdin and pipe purity separate from status records", async () => {
	const shell = new Shell();
	const chunks: string[] = [];
	let request: { stdin?: string } | undefined;
	const result = await shell.run(
		{ command: "printf input | xd probe | rg '^out$'", cwd: process.cwd(), xdCallId: "xd-stream" },
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
	expect(result.xdDispatches).toEqual(['{"kind":"probe"}']);

	const stderrOnly = await new Shell().run(
		{ command: "printf input | xd probe | rg '^not-piped$'", cwd: process.cwd(), xdCallId: "xd-stderr" },
		undefined,
		async () => JSON.stringify({ stdout: "out\n", stderr: "not-piped\n", exitCode: 0, record: "{}" }),
	);
	expect(stderrOnly.exitCode).toBe(1);
});
