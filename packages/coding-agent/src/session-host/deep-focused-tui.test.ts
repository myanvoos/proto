import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { workerEnvFromParent } from "../subprocess/worker-client";

interface Stage {
	phase: string;
	hasUI: boolean;
	mode: string;
	depth: number;
	sessionId: string;
	nodeId: string;
	rootId: string;
	rootUnchanged: boolean;
	sourceTreeUnchanged: boolean;
	worker?: { id: string; parentNodeId: string; rootId: string };
}

interface DriverProof {
	success: boolean;
	steps: string[];
	report: {
		selected: { id: string; sessionId: string; label: string };
		rootSessionId: string;
		stages: Stage[];
		compactions: Array<{ sessionId: string; summary: string; fromExtension: boolean; entryId: string }>;
		providerRequests: Array<{ model: string; level: number }>;
	};
}

test.skipIf(process.platform === "win32")(
	"real full TUI targets depth-three context, compaction, tree and independent fork",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-deep-focused-tui-"));
		const driver = path.resolve(import.meta.dir, "../../test/fixtures/deep-focused-tui.ts");
		const env = workerEnvFromParent({
			HOME: root,
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			PROTO_DEEP_FOCUSED_ROOT: root,
			PROTO_DAEMON_PROJECT_DIR: path.join(root, "project"),
			PROTO_DAEMON_RUNTIME_DIR: path.join(root, "run"),
			PROTO_DAEMON_IDLE_GRACE_MS: "60000",
			PI_BLACKHOLE_PASSIVE: "1",
			TMPDIR: path.join(root, "tmp"),
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "cache", "bun"),
		});
		const allowedEnvironment: Record<string, true> = {
			PATH: true,
			HOME: true,
			PI_CODING_AGENT_DIR: true,
			XDG_CONFIG_HOME: true,
			XDG_STATE_HOME: true,
			XDG_DATA_HOME: true,
			XDG_CACHE_HOME: true,
			PROTO_DEEP_FOCUSED_ROOT: true,
			PROTO_DAEMON_PROJECT_DIR: true,
			PROTO_DAEMON_RUNTIME_DIR: true,
			PROTO_DAEMON_IDLE_GRACE_MS: true,
			PI_BLACKHOLE_PASSIVE: true,
			TMPDIR: true,
			LANG: true,
			LC_ALL: true,
			LD_LIBRARY_PATH: true,
			DYLD_LIBRARY_PATH: true,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: true,
		};
		for (const key of Object.keys(env)) if (!allowedEnvironment[key]) delete env[key];
		await fs.mkdir(env.TMPDIR!, { recursive: true });
		const child = Bun.spawn([process.execPath, driver], {
			env,
			cwd: root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 210_000,
		});
		let passed = false;
		let failure: unknown;
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0) throw new Error(`Deep TUI driver failed (${code}); artifacts: ${root}\n${stderr}\n${stdout}`);
			const proof = (await Bun.file(path.join(root, "driver-proof.json")).json()) as DriverProof;
			expect(proof.success).toBe(true);
			const report = proof.report;
			expect(report.selected.label).toBe("Deep3");
			expect(report.selected.sessionId).not.toBe(report.rootSessionId);
			for (const phase of ["focused", "dialog", "compact", "tree", "beforefork"]) {
				const stage = report.stages.find(candidate => candidate.phase === phase);
				expect(stage?.hasUI).toBe(true);
				expect(stage?.mode).toBe("tui");
				expect(stage?.depth).toBe(3);
				expect(stage?.sessionId).toBe(report.selected.sessionId);
				expect(stage?.rootUnchanged).toBe(true);
				expect(stage?.sourceTreeUnchanged).toBe(true);
			}
			const fork = report.stages.find(stage => stage.phase === "fork");
			expect(fork?.depth).toBe(0);
			expect(fork?.sessionId).not.toBe(report.selected.sessionId);
			expect(fork?.sessionId).not.toBe(report.rootSessionId);
			expect(fork?.rootId).toBe(fork?.nodeId);
			const independent = report.stages.find(stage => stage.phase === "independent");
			expect(independent?.sessionId).toBe(fork?.sessionId);
			expect(independent?.depth).toBe(0);
			expect(independent?.worker?.parentNodeId).toBe(fork?.nodeId);
			expect(independent?.worker?.rootId).toBe(fork?.nodeId);
			expect(independent?.rootUnchanged).toBe(true);
			expect(independent?.sourceTreeUnchanged).toBe(true);
			expect(report.compactions).toContainEqual(
				expect.objectContaining({
					sessionId: report.selected.sessionId,
					summary: "DEPTH3_COMPACT_SUMMARY",
					fromExtension: true,
				}),
			);
			expect(report.providerRequests.some(request => request.level === 3 && request.model === "child")).toBe(true);
			passed = true;
		} catch (error) {
			failure = error;
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			const cleanup = Bun.spawn([process.execPath, driver, "--cleanup"], {
				env,
				cwd: root,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				timeout: 20_000,
			});
			const [cleanupCode, cleanupError] = await Promise.all([cleanup.exited, new Response(cleanup.stderr).text()]);
			if (cleanupCode !== 0)
				failure ??= new Error(`Isolated broker cleanup failed; artifacts: ${root}\n${cleanupError}`);
			if (passed && !failure) await fs.rm(root, { recursive: true, force: true });
		}
		if (failure) throw failure;
	},
	240_000,
);
