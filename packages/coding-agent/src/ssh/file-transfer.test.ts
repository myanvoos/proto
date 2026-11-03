import { afterEach, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import * as connections from "./connection-manager";
import { listRemoteDir, remoteHomeDirectory } from "./file-transfer";

afterEach(() => vi.restoreAllMocks());

function localTransport(): void {
	spyOn(connections, "ensureConnection").mockResolvedValue(undefined);
	spyOn(connections, "ensureHostInfo").mockResolvedValue({
		version: 1,
		os: "linux",
		shell: "sh",
		transferShell: "sh",
	});
	spyOn(connections, "buildRemoteCommand").mockImplementation(async (_target, command) => [command]);
	const spawn = ptree.spawn;
	spyOn(ptree, "spawn").mockImplementation((argv, options) => spawn(["sh", "-c", argv[1]!], options));
}

test("remote directory transport preserves newline-containing names and directory classification", async () => {
	localTransport();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-list-"));
	try {
		await fs.mkdir(path.join(dir, "folder"));
		await Bun.write(path.join(dir, "two\nlines"), "content");
		expect(await listRemoteDir({ name: "local-list", host: "local" }, dir)).toEqual([
			{ name: "folder", isDirectory: true },
			{ name: "two\nlines", isDirectory: false },
		]);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("remote HOME is read from the connected shell, not expanded from a caller path", async () => {
	localTransport();
	const home = await remoteHomeDirectory({ name: `local-home-${crypto.randomUUID()}`, host: "local" });
	expect(home).toBe(os.homedir());
});
