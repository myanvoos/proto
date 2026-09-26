import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import { disposeBashSessions } from "../exec/bash-executor";
import type { ToolSession } from ".";
import { BashTool } from "./bash";

for (const lang of ["python", "node"] as const) {
	test(`${lang} concurrent native shell cells retain separate env and stdin across await`, async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "kernel-concurrent-overlays-"));
		const owner = `kernel-concurrent-overlays-${crypto.randomUUID()}`;
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
		const commands = ["alpha", "beta"].map((label, index) => {
			const source =
				lang === "python"
					? `import asyncio, os, sys
async def concurrent_overlay_probe(label):
    print(label + " before env=" + os.environ.get("OVERLAY_PROBE", "missing") + " stdin=" + sys.stdin.read(1), flush=True)
    await asyncio.sleep(0.15)
    print(label + " after env=" + os.environ.get("OVERLAY_PROBE", "missing") + " stdin=" + sys.stdin.read(), flush=True)
await concurrent_overlay_probe("${label}")`
					: `await (async () => {
    const label = "${label}";
    const stdin = process.stdin;
    console.log(label + " before env=" + process.env.OVERLAY_PROBE);
    const delay = Promise.withResolvers();
    setTimeout(delay.resolve, 150);
    await delay.promise;
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    console.log(label + " after env=" + process.env.OVERLAY_PROBE + " stdin=" + input + " same-stream=" + (stdin === process.stdin));
})()`;
			return `printf "${index === 0 ? "A1" : "B2"}" | OVERLAY_PROBE=${label} ${lang} ${flag} '${source}' &`;
		});
		try {
			const result = await bash.execute("concurrent-overlays", { command: `${commands.join("\n")}\nwait` });
			const output = result.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n");
			expect(result.isError).not.toBe(true);
			if (lang === "python") {
				expect(output).toContain("alpha before env=alpha stdin=A");
				expect(output).toContain("alpha after env=alpha stdin=1");
				expect(output).toContain("beta before env=beta stdin=B");
				expect(output).toContain("beta after env=beta stdin=2");
			} else {
				expect(output).toContain("alpha before env=alpha");
				expect(output).toContain("alpha after env=alpha stdin=A1 same-stream=true");
				expect(output).toContain("beta before env=beta");
				expect(output).toContain("beta after env=beta stdin=B2 same-stream=true");
			}
			expect(output.match(/ before env=/g)).toHaveLength(2);
			expect(output.match(/ after env=/g)).toHaveLength(2);
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
