import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disposeKernelSessionsByOwner } from "../eval/py/executor";
import type { EvalStatusEvent } from "../eval/types";
import { initTheme, theme } from "../modes/theme/theme";
import type { ToolSession } from ".";
import { BashTool, type BashToolDetails } from "./bash";
import { toolRenderers } from "./renderers";

await initTheme(false, false, "proto");

// Contract (prompts/tools/bash.md): a shell write that owns its target reports
// one `<shell> note:` receipt plus a hunk, and refuses to clobber a file that
// changed since this shell read it — the guarantees kernel cell writes have.
const OWNER = `bash-write-receipt:${process.pid}`;

function stubSession(cwd: string): ToolSession {
	const settings = new Map<string, unknown>();
	return {
		cwd,
		settings: { get: (key: string) => settings.get(key), getShellConfig: () => ({ env: {} }) },
		getEvalSessionId: () => `bash-write-receipt:${cwd}`,
		getEvalKernelOwnerId: () => OWNER,
	} as unknown as ToolSession;
}

interface Ran {
	text: string;
	notes: string[];
	statusEvents: EvalStatusEvent[];
}

async function run(tool: BashTool, id: string, command: string): Promise<Ran> {
	const result = await tool.execute(id, { command });
	const text = result.content
		.filter(block => block.type === "text")
		.map(block => (block.type === "text" ? block.text : ""))
		.join("\n");
	return {
		text,
		notes: text
			.split("\n")
			.filter(line => line.startsWith("<shell> note:"))
			.map(line => line.trim()),
		statusEvents: (result.details as BashToolDetails | undefined)?.statusEvents ?? [],
	};
}

afterAll(async () => {
	await disposeKernelSessionsByOwner(OWNER);
});

test("a redirection reports creation, then overwrite, with diff stats and a hunk", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-receipt-"));
	try {
		const tool = new BashTool(stubSession(dir));
		const created = await run(tool, "create", "printf 'one\\ntwo\\n' > notes.txt");
		expect(created.notes).toEqual(["<shell> note: created notes.txt (2 lines)"]);
		expect(await Bun.file(path.join(dir, "notes.txt")).text()).toBe("one\ntwo\n");

		const rewritten = await run(tool, "rewrite", "printf 'one\\nTWO\\n' > notes.txt");
		expect(rewritten.notes).toEqual(["<shell> note: wrote notes.txt (+1 \u22121)"]);
		const [event] = rewritten.statusEvents;
		expect(event?.op).toBe("write");
		expect(event?.path).toBe(path.join(dir, "notes.txt"));
		expect(String(event?.diff)).toContain("TWO");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("appends report their added lines and reads report nothing", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-append-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await Bun.write(path.join(dir, "log.txt"), "first\n");
		const appended = await run(tool, "append", "printf 'second\\n' >> log.txt");
		expect(appended.notes).toEqual(["<shell> note: wrote log.txt (+1 \u22120)"]);
		expect(await Bun.file(path.join(dir, "log.txt")).text()).toBe("first\nsecond\n");

		const read = await run(tool, "read", "cat log.txt");
		expect(read.notes).toEqual([]);
		expect(read.statusEvents).toEqual([]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("a command that never reaches its redirection reports no write", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-skipped-"));
	try {
		const tool = new BashTool(stubSession(dir));
		const skipped = await run(tool, "skipped", "false && printf 'x\\n' > never.txt");
		expect(skipped.notes).toEqual([]);
		expect(await Bun.file(path.join(dir, "never.txt")).exists()).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("a redirection refuses to clobber a file changed since the shell read it", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-stale-"));
	const target = path.join(dir, "shared.txt");
	try {
		const tool = new BashTool(stubSession(dir));
		await Bun.write(target, "original\n");
		await run(tool, "seed-read", "cat shared.txt");

		await Bun.write(target, "edited by someone else\n");
		const stale = await run(tool, "stale", "printf 'mine\\n' > shared.txt");
		expect(stale.text).toContain("StaleWriteError");
		expect(stale.notes).toEqual([]);
		// The refusal happens before truncation, so the other edit survives intact.
		expect(await Bun.file(target).text()).toBe("edited by someone else\n");

		// Re-reading re-arms the guard; the same write then lands and reports.
		await run(tool, "reread", "cat shared.txt");
		const written = await run(tool, "retry", "printf 'mine\\n' > shared.txt");
		expect(written.notes).toEqual(["<shell> note: wrote shared.txt (+1 \u22121)"]);
		expect(await Bun.file(target).text()).toBe("mine\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("tee reports its write like a redirection", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-tee-"));
	try {
		const tool = new BashTool(stubSession(dir));
		const teed = await run(tool, "tee", "printf 'piped\\n' | tee copy.txt");
		expect(teed.notes).toEqual(["<shell> note: created copy.txt (1 line)"]);
		expect(await Bun.file(path.join(dir, "copy.txt")).text()).toBe("piped\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

test("one command redirecting twice to a path reports a single net write", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-net-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await Bun.write(path.join(dir, "net.txt"), "start\n");
		const net = await run(tool, "net", "printf 'middle\\n' > net.txt && printf 'end\\n' > net.txt");
		expect(net.notes).toEqual(["<shell> note: wrote net.txt (+1 \u22121)"]);
		expect(net.statusEvents).toHaveLength(1);
		expect(String(net.statusEvents[0]?.diff)).toContain("end");
		expect(await Bun.file(path.join(dir, "net.txt")).text()).toBe("end\n");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);

// The receipt is model-facing text; the hunk is the card's own affordance, so a
// plain (non-kernel) shell command has to grow a Status rail like a kernel cell.
test("a cat heredoc's card shows its write hunk on a Status rail", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-write-render-"));
	try {
		const tool = new BashTool(stubSession(dir));
		await Bun.write(path.join(dir, "card.txt"), "old\n");
		const command = "cat > card.txt <<'EOF'\nnew\nEOF";
		const result = await tool.execute("render", { command });
		const renderer = toolRenderers.bash as unknown as {
			renderResult: (r: unknown, o: unknown, t: unknown, a: unknown) => { render: (w: number) => string[] };
		};
		const rendered = renderer
			.renderResult(result, { expanded: false }, theme, { command })
			.render(90)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(rendered).toContain("Status");
		expect(rendered).toContain("card.txt");
		expect(rendered).toContain("new");
		expect(rendered).toContain("old");
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}, 60000);
