import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { workerHostEntry } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { connectSessionRpc } from "./client";
import { negotiateSessionHost } from "./ensure";
import { SESSION_HOST_READY_PATTERN, SESSION_HOST_SOCKET_ENV, SESSION_HOST_WORKER_ARG } from "./protocol";

const BOOTSTRAP_TIMEOUT_MS = 90_000;

describe("session host worker", () => {
	let tmpDir: string;
	let sessionFile: string;
	let socketPath: string;
	let hostStdout = "";
	let hostStderr = "";
	let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;

	beforeAll(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-session-host-"));
		// Hand-written minimal session file — SessionManager would write into the
		// real config root from the unsandboxed test process.
		sessionFile = path.join(tmpDir, "session.jsonl");
		await fs.writeFile(
			sessionFile,
			[
				JSON.stringify({ type: "title", v: 1, title: "", updatedAt: new Date().toISOString(), pad: "" }),
				JSON.stringify({
					type: "session",
					version: 3,
					id: "00000000-0000-4000-8000-000000000002",
					timestamp: new Date().toISOString(),
					cwd: tmpDir,
				}),
				"",
			].join("\n"),
		);
		const extensionPath = path.join(tmpDir, "large-catalog.ts");
		await Bun.write(
			extensionPath,
			`export default function(api) {
			for (let index = 0; index < 320; index++) {
				api.registerCommand("transport-catalog-" + index, {
					description: "雪🦊" + "x".repeat(4096) + " catalog-tail-" + index,
					handler: async () => {},
				});
			}
		}`,
		);
		socketPath = path.join(tmpDir, "host.sock");
		// resolveWorkerSpawnCmd's bun-test fallback uses a package-root-relative
		// entry; resolve it absolutely so the worker can run with cwd = project.
		const hostEntry = workerHostEntry() ?? path.resolve(import.meta.dir, "..", "cli.ts");
		child = Bun.spawn({
			cmd: [
				process.execPath,
				hostEntry,
				SESSION_HOST_WORKER_ARG,
				"--resume",
				sessionFile,
				"--mode",
				"rpc",
				"--trusted-extension",
				extensionPath,
			],
			env: workerEnvFromParent({
				HOME: tmpDir,
				PI_CODING_AGENT_DIR: path.join(tmpDir, "agent"),
				ANTHROPIC_API_KEY: "sk-ant-dummy-session-host-test",
				[SESSION_HOST_SOCKET_ENV]: socketPath,
			}),
			cwd: tmpDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Drain stdout/stderr continuously like the broker's log capture does —
		// an undrained pipe would eventually block the host on write.
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
				hostStdout += decoder.decode(chunk, { stream: true });
				if (hostStdout.length > 64_000) hostStdout = hostStdout.slice(-32_000);
			}
		})();
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
				hostStderr += decoder.decode(chunk, { stream: true });
				if (hostStderr.length > 64_000) hostStderr = hostStderr.slice(-32_000);
			}
		})();
		// Broker readiness means the RPC loop is serving, not just that listen() succeeded.
		const waitForReadyLine = async (): Promise<void> => {
			while (!hostStdout.includes(SESSION_HOST_READY_PATTERN)) {
				await Bun.sleep(20);
			}
		};
		await Promise.race([
			waitForReadyLine(),
			child.exited.then(code => {
				throw new Error(`session host exited (code ${code}) before ready line\n${hostStderr}`);
			}),
		]);
	});

	afterAll(async () => {
		child?.kill();
		await child?.exited;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("serves RPC over the socket, survives client churn, and reports unknown commands", async () => {
		const probe = await negotiateSessionHost(socketPath, BOOTSTRAP_TIMEOUT_MS);
		if (probe.socket !== "live") {
			throw new Error(
				`Hosted handshake failed: ${JSON.stringify(probe)} (exit ${child?.exitCode})\nstdout: ${hostStdout}\nstderr: ${hostStderr}`,
			);
		}
		expect(probe.socket).toBe("live");

		const first = await connectSessionRpc(socketPath);
		first.sendCommand({ id: "first-negotiate", type: "negotiate_protocol", protocolVersion: 2 });
		expect((await first.frames.findResponse("first-negotiate", BOOTSTRAP_TIMEOUT_MS)).success).toBe(true);
		first.sendCommand({ id: "large-catalog", type: "get_available_commands" });
		first.sendCommand({ id: "unicode-雪🦊", type: "get_state" });
		const catalog = await first.frames.findResponse("large-catalog", BOOTSTRAP_TIMEOUT_MS);
		expect(catalog.success).toBe(true);
		const commands = (catalog.data as { commands: { name: string; description: string }[] }).commands;
		const added = commands.filter(command => command.name.startsWith("transport-catalog-"));
		expect(added).toHaveLength(320);
		expect(added.find(command => command.name === "transport-catalog-319")?.description).toBe(
			`雪🦊${"x".repeat(4096)} catalog-tail-319`,
		);
		expect(Buffer.byteLength(JSON.stringify(catalog))).toBeGreaterThan(1024 * 1024);
		expect((await first.frames.findResponse("unicode-雪🦊", BOOTSTRAP_TIMEOUT_MS)).success).toBe(true);
		first.sendCommand({ id: "state-1", type: "get_state" });
		const response = await first.frames.findResponse("state-1", BOOTSTRAP_TIMEOUT_MS);
		expect(response.success).toBe(true);
		const reportedFile = (response.data as { sessionFile?: string }).sessionFile;
		if (!reportedFile) throw new Error("Host response omitted its session file");
		expect(path.isAbsolute(reportedFile)).toBe(true);
		expect(await fs.realpath(reportedFile)).toBe(await fs.realpath(sessionFile));

		// Latest client wins: attaching a second client closes the first.
		const second = await connectSessionRpc(socketPath);
		await first.closed;
		second.sendCommand({ id: "state-2", type: "get_state" });
		const secondResponse = await second.frames.findResponse("state-2", BOOTSTRAP_TIMEOUT_MS);
		expect(secondResponse.success).toBe(true);

		// Host survives client disconnect: detach must not dispose the session.
		second.close();
		const redetach = await negotiateSessionHost(socketPath, BOOTSTRAP_TIMEOUT_MS);
		expect(redetach.socket).toBe("live");

		// Unknown commands surface an error response instead of crashing the host.
		const third = await connectSessionRpc(socketPath);
		third.sendCommand({ id: "bogus-1", type: "definitely_not_a_command" });
		const errorResponse = await third.frames.findResponse("bogus-1", BOOTSTRAP_TIMEOUT_MS);
		expect(errorResponse.success).toBe(false);
		third.close();
	}, 120_000);
});
