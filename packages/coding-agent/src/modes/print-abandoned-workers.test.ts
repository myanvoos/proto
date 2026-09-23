import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// The defect was that `proto -p` ended a run while a worker turn was still in flight, terminating
// it with no word to the operator. Only the real CLI shows that, so this drives it against a
// loopback provider that scripts one orchestrating turn and one worker that keeps working.
const cliEntry = path.resolve(import.meta.dir, "..", "cli.ts");
const WORKER_LABEL = "sloww";
const encoder = new TextEncoder();

type Step = { text: string } | { call: { name: string; args: unknown } };

function framesFor(id: string, step: Step): Record<string, unknown>[] {
	const frames: Record<string, unknown>[] = [
		{ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } },
	];
	if ("call" in step) {
		const args = JSON.stringify(step.call.args);
		const item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: step.call.name };
		frames.push(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...item, arguments: "", status: "in_progress" },
			},
			{ type: "response.function_call_arguments.delta", delta: args, item_id: `fc_${id}`, output_index: 0 },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { ...item, arguments: args, status: "completed" },
			},
		);
	} else {
		const message = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed" };
		frames.push(
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...message, status: "in_progress", content: [] },
			},
			{
				type: "response.output_text.delta",
				content_index: 0,
				delta: step.text,
				item_id: `msg_${id}`,
				output_index: 0,
				logprobs: [],
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { ...message, content: [{ type: "output_text", text: step.text, annotations: [] }] },
			},
		);
	}
	frames.push({
		type: "response.completed",
		response: { id, status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
	});
	return frames;
}

/** Main delegates once then finishes; the worker it spawned starts work that outlives the run. */
function stepFor(lane: string, turn: number): Step {
	if (lane !== "main") return { call: { name: "bash", args: { command: "sleep 30", i: "Long work" } } };
	if (turn === 0) {
		return {
			call: {
				name: "orchestrate_spawn",
				args: { message: "LANE_w1 do long work", label: WORKER_LABEL, i: "Spawning" },
			},
		};
	}
	return { text: "MAIN DONE" };
}

const turnsByLane = new Map<string, number>();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 60,
	async fetch(req) {
		const body = (await req.json()) as { tools?: unknown[]; input?: unknown[] };
		const marked = (body.input ?? []).find(
			item => !!item && typeof item === "object" && "role" in item && item.role === "user",
		);
		const laneMatch = /LANE_([A-Za-z0-9_-]+)/.exec(JSON.stringify(marked ?? ""));
		// Side requests that carry no tools (titles, advisors) must not consume a scripted turn.
		const lane = (body.tools ?? []).length === 0 ? "aux" : (laneMatch?.[1] ?? "main");
		const turn = turnsByLane.get(lane) ?? 0;
		turnsByLane.set(lane, turn + 1);
		const id = `${lane}-${turn}`;
		const frames = framesFor(id, lane === "aux" ? { text: "AUX" } : stepFor(lane, turn));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let sequence = 0;
				for (const value of frames) {
					sequence++;
					controller.enqueue(
						encoder.encode(
							`event: ${value.type}\ndata: ${JSON.stringify({ ...value, sequence_number: sequence })}\n\n`,
						),
					);
				}
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
	},
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-print-abandoned-"));
const home = path.join(root, "home");
const agentDir = path.join(root, "profile");
const cwd = path.join(root, "work");
for (const dir of [home, agentDir, cwd]) await fs.mkdir(dir, { recursive: true });

await fs.writeFile(
	path.join(agentDir, "config.yml"),
	[
		"startup:",
		"  setupWizard: false",
		"  checkUpdate: false",
		"  quiet: true",
		"retry:",
		"  maxRetries: 1",
		"  baseDelayMs: 50",
		"  modelFallback: false",
		"",
	].join("\n"),
);
await fs.writeFile(
	path.join(agentDir, "models.yml"),
	[
		"providers:",
		"  loopback:",
		`    baseUrl: http://127.0.0.1:${server.port}/v1`,
		"    apiKey: loopback-fixture",
		"    api: openai-responses",
		"    models:",
		"      - id: scripted",
		'        name: "Scripted"',
		"        reasoning: false",
		"        contextWindow: 32768",
		"        maxTokens: 4096",
		"",
	].join("\n"),
);

afterAll(async () => {
	server.stop(true);
	await fs.rm(root, { recursive: true, force: true });
});

test("print mode names the worker turns it terminates instead of ending silently", async () => {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			cliEntry,
			"--cwd",
			cwd,
			"--no-title",
			"--model",
			"loopback/scripted",
			"--smol",
			"loopback/scripted",
			"--slow",
			"loopback/scripted",
			"-p",
			"LANE_main delegate the slow work",
		],
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			XDG_CACHE_HOME: path.join(home, ".cache"),
			XDG_DATA_HOME: path.join(home, ".local", "share"),
			XDG_STATE_HOME: path.join(home, ".local", "state"),
			PI_CODING_AGENT_DIR: agentDir,
			NO_PROXY: "127.0.0.1,localhost",
			TERM: "dumb",
			NO_COLOR: "1",
		},
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const exitCode = await child.exited;
	const err = await stderr;

	expect(exitCode).toBe(0);
	expect(await stdout).toContain("MAIN DONE");
	expect(err).toContain("still running");
	expect(err).toContain(WORKER_LABEL);
	expect(err).toContain("orchestrate_wait");
}, 90_000);
