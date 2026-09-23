import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { createDaemonBrokerClient } from "../launch/client";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { stopSessionHost } from "./ensure";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "proto-attach-terminal-"));
const project = path.join(tmp, "project");
const sessionName = `long session's-界-${"path-".repeat(12)}.jsonl`;
const sessionFiles: string[] = [];
await fs.mkdir(project);
const replay = `REPLAY \x1b[2J\x1b]0;INJECTED_TITLE\x07界👩‍💻é\t${"wide界".repeat(24)}\rend`;
const initialEntries = [
	{ type: "title", v: 1, title: "", updatedAt: new Date().toISOString(), pad: "" },
	{
		type: "session",
		version: 3,
		id: "00000000-0000-4000-8000-000000000019",
		timestamp: new Date().toISOString(),
		cwd: project,
	},
	{
		type: "message",
		id: "replay-1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: [{ type: "text", text: replay }], timestamp: Date.now() },
	},
];

async function attach(
	cols: number,
	drive: (
		pty: PtySession,
		waitFor: (needle: string, completeLine?: boolean, startAt?: number) => Promise<void>,
		read: () => string,
		session: string,
	) => Promise<void>,
): Promise<void> {
	const session = path.join(tmp, `${sessionFiles.length}-${sessionName}`);
	sessionFiles.push(session);
	await fs.writeFile(
		session,
		`${initialEntries
			.map(entry => JSON.stringify(entry.type === "session" ? { ...entry, id: crypto.randomUUID() } : entry))
			.join("\n")}\n`,
	);
	const pty = new PtySession();
	let output = "";
	const listeners = new Set<() => void>();
	const run = pty.startArgv(
		{
			application: process.execPath,
			args: [path.resolve(import.meta.dir, "../cli.ts"), "attach", session, "--dir", project],
			cwd: project,
			env: workerEnvFromParent({
				HOME: tmp,
				XDG_CONFIG_HOME: path.join(tmp, "config"),
				XDG_STATE_HOME: path.join(tmp, "state"),
				PI_CODING_AGENT_DIR: path.join(tmp, "agent"),
				ANTHROPIC_API_KEY: "sk-ant-dummy-attach-terminal",
				PROTO_DAEMON_IDLE_GRACE_MS: "1000",
				TERM: "xterm-256color",
				FORCE_COLOR: "1",
			}),
			cols,
			rows: 24,
		},
		(_error, chunk) => {
			output += chunk;
			for (const listener of listeners) listener();
		},
	);
	const waitFor = async (needle: string, completeLine = false, startAt = 0): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const listener = () => {
			const visible = Bun.stripANSI(output.slice(startAt));
			const index = visible.indexOf(needle);
			if (index >= 0 && (!completeLine || visible.indexOf("\n", index + needle.length) >= 0)) resolve();
		};
		listeners.add(listener);
		listener();
		// Deadline against the native child clock; fake timers cannot advance the PTY process.
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => deadline.reject(new Error(`Missing ${JSON.stringify(needle)}\n${output}`)),
			30_000,
		);
		try {
			await Promise.race([promise, deadline.promise]);
		} finally {
			clearTimeout(timer);
			listeners.delete(listener);
		}
	};
	try {
		await waitFor("commands: /bash");
		await drive(pty, waitFor, () => output, session);
	} finally {
		await fs.writeFile(path.join(tmp, `capture-${cols}-${Date.now()}.ansi`), output);
		try {
			pty.kill();
		} catch {}
		await run;
	}
}

for (const width of [20, 30, 40]) {
	test(`attach replay uses safe terminal cells at ${width} columns`, async () => {
		await attach(width, async (pty, waitFor, read) => {
			const output = read();
			expect(output).not.toContain("\x1b[2J");
			expect(output).not.toContain("\x1b]0;INJECTED_TITLE");
			const replayLine = Bun.stripANSI(output)
				.split(/\r?\n/)
				.find(line => line.startsWith("you: REPLAY"));
			expect(replayLine).toBeDefined();
			expect(Bun.stringWidth(replayLine!)).toBeLessThanOrEqual(width);
			expect(replayLine).not.toContain("�");
			expect(output).toContain("\x1b[1myou");
			for (const nextWidth of [40, 20]) {
				const startAt = read().length;
				pty.resize(nextWidth, 24);
				pty.write(`/bash printf "RESIZE${nextWidth}_界👩‍💻abcdefghijklmnopqrstuvwxyz0123456789"\r`);
				await waitFor(`\nRESIZE${nextWidth}_`, true, startAt);
				const result = Bun.stripANSI(read().slice(startAt))
					.split(/\r?\n/)
					.find(line => line.startsWith(`RESIZE${nextWidth}_`));
				expect(Bun.stringWidth(result!)).toBe(nextWidth);
			}
			expect(Bun.stripANSI(read())).toContain("/bash printf");
		});
	}, 90_000);
}

test("terminal string replies do not leak into the edited command", async () => {
	await attach(30, async (pty, waitFor, read) => {
		const startAt = read().length;
		pty.write("/bash printf '%s' 'INPUT_");
		for (const sequence of ["\x1b]0;TITLE_LEAK\x07", "\x1bPSTRING_LEAK\x1b\\"]) {
			pty.write(sequence.slice(0, -1));
			// Deliberate native input fragmentation; child-clock timing cannot be faked.
			await Bun.sleep(10);
			pty.write(sequence.slice(-1));
		}
		pty.write("OK'\r");
		await waitFor("\nINPUT_OK", true, startAt);
	});
}, 90_000);

test("attach accepts split CSI/SS3 and Alt keys without detaching, then honors coalesced Escape", async () => {
	await attach(30, async (pty, waitFor, read, session) => {
		for (const sequence of ["\x1b[D", "\x1bOD", "\x1bb"]) {
			const startAt = read().length;
			pty.write(sequence.slice(0, 1));
			// Deliberately tear native terminal input; the child parser uses the platform clock.
			await Bun.sleep(10);
			pty.write(sequence.slice(1));
			const marker = `KEY_OK_${sequence.charCodeAt(1)}`;
			pty.write(`/bash echo ${marker}\r`);
			await waitFor(`\n${marker}`, true, startAt);
			expect(read()).not.toContain("aborted and detached");
		}
		const pasteStart = read().length;
		// Bytes trailing the paste terminator in the same burst are payload, never keystrokes:
		// a pasted file containing ESC[201~ must not be able to press Enter. Submit separately,
		// the way a real terminal delivers a keystroke that follows a paste.
		pty.write("\x1b[200~/bash printf '%s' 'PASTE_界'\x1b[201~");
		await Bun.sleep(50);
		pty.write("\r");
		await waitFor("\nPASTE_界", true, pasteStart);
		pty.write("\x1b[D\x1b");
		await waitFor("Reattach with:", true);
		expect(Bun.stripANSI(read())).toContain("aborted and detached");
		const command = Bun.stripANSI(read())
			.split(/\r?\n/)
			.find(line => line.startsWith("Reattach with: "))!
			.slice("Reattach with: proto attach ".length);
		// The session is positional; only the project directory carries a flag.
		const decoded = Bun.spawn(["sh", "-c", `set -- ${command}; printf '%s\\n%s\\n%s' "$1" "$2" "$3"`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await new Response(decoded.stdout).text()).toBe(`${session}\n--dir\n${project}`);
		expect(await decoded.exited).toBe(0);
	});
}, 90_000);

test("Ctrl-C aborts then detaches without readline closing early", async () => {
	await attach(30, async (pty, waitFor, read) => {
		pty.write("\x03\x03");
		await waitFor("Reattach with:", true);
		const output = Bun.stripANSI(read());
		expect(output).toContain("abort requested");
		expect(output).toContain("detached");
		expect(output).not.toContain("input closed");
	});
}, 90_000);

afterAll(async () => {
	for (const entry of await fs.readdir(tmp, { recursive: true })) {
		if (!entry.endsWith("broker.sock")) continue;
		const client = await createDaemonBrokerClient(project, { runtimeDir: path.dirname(path.join(tmp, entry)) });
		try {
			for (const session of sessionFiles) await stopSessionHost(project, session, { client });
			await client.request({ op: "shutdown" }).catch(() => undefined);
		} finally {
			client.close();
		}
	}
	if (process.env.PROTO_ATTACH_CAPTURE_DIR) {
		await fs.mkdir(process.env.PROTO_ATTACH_CAPTURE_DIR, { recursive: true });
		for (const name of await fs.readdir(tmp)) {
			if (name.endsWith(".ansi"))
				await fs.copyFile(path.join(tmp, name), path.join(process.env.PROTO_ATTACH_CAPTURE_DIR, name));
		}
	}
	await fs.rm(tmp, { recursive: true, force: true });
});
