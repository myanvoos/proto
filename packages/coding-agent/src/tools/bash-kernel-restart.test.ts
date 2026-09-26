import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

for (const lang of ["python", "node"] as const) {
	test(`${lang} native shell reports lost state once after a real kernel crash`, async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-restart-"));
		const owner = `kernel-restart-${crypto.randomUUID()}`;
		const session = {
			cwd,
			settings: { get: () => undefined, getShellConfig: () => ({ env: {} }) },
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			getSessionId: () => owner,
			getEvalSessionId: () => owner,
			getEvalKernelOwnerId: () => owner,
		} as unknown as ToolSession;
		const bash = new BashTool(session);
		const flag = lang === "python" ? "-c" : "-e";
		try {
			const seedCode =
				lang === "python"
					? 'restart_marker = 41; print("seed", restart_marker); print("generation=" + kernel_state()["generation"])'
					: 'globalThis.restart_marker = 41; console.log("seed", restart_marker); console.log("generation=" + kernelState().generation)';
			const seeded = await bash.execute("restart-seed", {
				command: `printf "native-seed\\n"; ${lang} ${flag} '${seedCode}'`,
			});
			expect(seeded.isError).not.toBe(true);
			const seededText = text(seeded);
			expect(seededText).toContain("native-seed");
			expect(seededText).toContain("seed 41");
			expect(seededText).not.toContain("<kernel> state lost:");
			const previous = /generation=([^\s]+)/.exec(seededText)?.[1];
			expect(previous).toBeString();

			const crashCode = lang === "python" ? "import os; os._exit(17)" : 'process.kill(process.pid, "SIGKILL")';
			const crashed = await bash.execute("restart-crash", {
				command: `printf "native-crash\\n"; ${lang} ${flag} '${crashCode}'`,
			});
			expect(text(crashed)).toContain("native-crash");
			expect(crashed.details?.exitCode).toBe(lang === "python" ? 130 : 1);
			if (lang === "node") expect(text(crashed)).toContain("completion is uncertain");

			const inspectCode =
				lang === "python"
					? 'print("binding-present=" + str("restart_marker" in globals()).lower()); print("generation=" + kernel_state()["generation"])'
					: 'console.log("binding-present=" + Object.hasOwn(globalThis, "restart_marker")); console.log("generation=" + kernelState().generation)';
			const restarted = await bash.execute("restart-inspect", {
				command: `printf "native-restarted\\n"; ${lang} ${flag} '${inspectCode}'`,
			});
			expect(restarted.isError).not.toBe(true);
			const restartedText = text(restarted);
			expect(restartedText).toContain("native-restarted");
			expect(restartedText).toContain("binding-present=false");
			expect(restartedText.match(/<kernel> state lost:/g)).toHaveLength(1);
			expect(restartedText).toContain("Earlier variables are gone.");
			const current = /generation=([^\s]+)/.exec(restartedText)?.[1];
			expect(current).toBeString();
			expect(current).not.toBe(previous);
			expect(restartedText).toContain(`generation ${previous} → ${current}`);

			const healthy = await bash.execute("restart-healthy", {
				command: `printf "native-healthy\\n"; ${lang} ${flag} '${inspectCode}'`,
			});
			expect(healthy.isError).not.toBe(true);
			expect(text(healthy)).toContain("native-healthy");
			expect(text(healthy)).toContain("binding-present=false");
			expect(text(healthy)).toContain(`generation=${current}`);
			expect(text(healthy)).not.toContain("<kernel> state lost:");
		} finally {
			await Promise.all([
				disposeBashSessions(owner),
				disposeKernelSessionsByOwner(owner),
				disposeVmContextsByOwner(owner),
			]);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 60_000);
}
