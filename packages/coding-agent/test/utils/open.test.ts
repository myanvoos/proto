import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import * as piUtils from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;
type SpawnCall = { cmd: string[]; options: SpawnOptions };

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function fakeProcess(): Subprocess {
	return {
		pid: 1,
		exited: Promise.resolve(0),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[]) {
	function mockSpawn(opts: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], opts?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		const cmd = Array.isArray(first) ? first : first.cmd;
		const options = Array.isArray(first) ? (second ?? ({} as SpawnOptions)) : (first as SpawnOptions);
		calls.push({ cmd, options });
		return fakeProcess();
	}
	return vi.spyOn(Bun, "spawn").mockImplementation(mockSpawn);
}

afterEach(() => {
	restorePlatform();
	vi.restoreAllMocks();
});

describe("openPath", () => {
	it("opens existing files through xdg-open on linux", () => {
		setPlatform("linux");
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath("/mnt/share/session.html");

		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", "/mnt/share/session.html"]]);
	});

	it("opens URLs through xdg-open on linux without inspecting the filesystem", () => {
		setPlatform("linux");
		const existsSyncSpy = vi.spyOn(fs, "existsSync");
		const spawnSyncSpy = vi.spyOn(Bun, "spawnSync");
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath("https://example.com");

		expect(existsSyncSpy).not.toHaveBeenCalled();
		expect(spawnSyncSpy).not.toHaveBeenCalled();
		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", "https://example.com"]]);
	});

	it("logs when the opener exits non-zero so silent misconfigurations are diagnosable", async () => {
		setPlatform("linux");
		const warnSpy = vi.spyOn(piUtils.logger, "warn").mockImplementation((() => {}) as never);
		const failing = {
			pid: 1,
			exited: Promise.resolve(1),
			kill: () => true,
		} as unknown as Subprocess;
		vi.spyOn(Bun, "spawn").mockImplementation(() => failing);

		openPath("https://example.com");
		await failing.exited;
		await Promise.resolve();

		expect(warnSpy).toHaveBeenCalledWith(
			"External opener exited with non-zero status",
			expect.objectContaining({ exitCode: 1 }),
		);
	});
});
