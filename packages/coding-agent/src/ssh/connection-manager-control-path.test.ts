import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import {
	buildRemoteCommand,
	closeAllConnections,
	ensureConnection,
	getControlDir,
	getControlPathTemplate,
} from "./connection-manager";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const dir = await TempDir.create("@ssh-control-path-");
	const log = path.join(dir.path(), "calls");
	const live = path.join(dir.path(), "live");
	const fakeSsh = path.join(dir.path(), "ssh");
	await Bun.write(log, "");
	await Bun.write(
		fakeSsh,
		`#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${log}'
case " $* " in
  *" -G "*)
    case "\${!#}" in
      cfg-*) echo "controlpath /tmp/user-master.sock" ;;
      none-*) echo "controlpath none" ;;
    esac
    exit 0 ;;
  *" -O check "*) test -f '${live}'; exit $? ;;
  *" -O exit "*) exit 0 ;;
  *" -M "*) exit 0 ;;
  *PI_HOST_PROBE=*) exit 0 ;;
esac
exec bash -c "\${!#}"
`,
	);
	await fs.promises.chmod(fakeSsh, 0o755);
	const realExec = ptree.exec;
	spyOn(ptree, "exec").mockImplementation((cmd, options) =>
		realExec(cmd[0] === "ssh" ? [fakeSsh, ...cmd.slice(1)] : cmd, options),
	);
	return { dir, live, calls: async () => (await Bun.file(log).text()).trim().split("\n") };
}

test("configured masters retain their socket and persistence policy and survive close", async () => {
	const { dir, live, calls } = await fixture();
	await using _cleanup = dir;
	await Bun.write(live, "");
	const host = { name: `test-${crypto.randomUUID()}`, host: `cfg-${crypto.randomUUID()}` };
	try {
		await ensureConnection(host);
		const args = await buildRemoteCommand(host, "true");
		expect(args.some(arg => arg.startsWith("ControlPath=") || arg.startsWith("ControlPersist="))).toBe(false);
		expect(args).toContain("BatchMode=yes");
		await closeAllConnections();
		const invocations = await calls();
		expect(invocations.some(call => call.includes("-O check"))).toBe(true);
		expect(invocations.some(call => call.startsWith("-M ") || call.includes("-O exit"))).toBe(false);
	} finally {
		await closeAllConnections();
	}
});

test("an absent configured master connects on demand and never terminates its later replacement", async () => {
	const { dir, live, calls } = await fixture();
	await using _cleanup = dir;
	const host = { name: `test-${crypto.randomUUID()}`, host: `cfg-${crypto.randomUUID()}` };
	try {
		await ensureConnection(host);
		await Bun.write(live, "user-master");
		await closeAllConnections();
		expect((await calls()).some(call => call.startsWith("-M ") || call.includes("-O exit"))).toBe(false);
	} finally {
		await closeAllConnections();
	}
});

test("missing and none ControlPath settings keep proto-owned sockets and close their masters", async () => {
	const { dir, calls } = await fixture();
	await using _cleanup = dir;
	try {
		for (const prefix of ["none", "plain"]) {
			const host = { name: `test-${crypto.randomUUID()}`, host: `${prefix}-${crypto.randomUUID()}` };
			await ensureConnection(host);
			const args = await buildRemoteCommand(host, "true");
			expect(args).toContain(`ControlPath=${getControlPathTemplate()}`);
			expect(args).toContain("ControlPersist=3600");
		}
		await closeAllConnections();
		const invocations = await calls();
		expect(invocations.filter(call => call.startsWith("-M "))).toHaveLength(2);
		expect(invocations.filter(call => call.includes("-O exit"))).toHaveLength(2);
	} finally {
		await closeAllConnections();
	}
});

test("verified connections skip checks only within the TTL for the same target and still recheck socket safety", async () => {
	const { dir, calls } = await fixture();
	await using _cleanup = dir;
	let now = Date.now();
	spyOn(Date, "now").mockImplementation(() => now);
	const mkdir = spyOn(fs, "mkdirSync");
	const host = { name: `test-${crypto.randomUUID()}`, host: `cfg-${crypto.randomUUID()}` };
	const checks = async () => (await calls()).filter(call => call.includes("-O check")).length;
	try {
		await ensureConnection(host);
		expect(await checks()).toBe(1);
		mkdir.mockClear();
		await ensureConnection(host);
		expect(await checks()).toBe(1);
		expect(mkdir.mock.calls.some(([dir]) => dir === getControlDir())).toBe(true);
		now += 30_001;
		await ensureConnection(host);
		expect(await checks()).toBe(2);
		await ensureConnection({ ...host, port: 2222 });
		expect(await checks()).toBe(3);
		await closeAllConnections();
		await ensureConnection(host);
		expect(await checks()).toBe(4);
	} finally {
		await closeAllConnections();
	}
});
