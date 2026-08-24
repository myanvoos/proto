import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as connectionManager from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withLooseKey<T>(run: (keyPath: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-ssh-key-"));
	const keyPath = path.join(dir, "id_ed25519");
	await Bun.write(keyPath, "dummy-key");
	await fs.chmod(keyPath, 0o666);
	try {
		return await run(keyPath);
	} finally {
		await removeWithRetries(dir);
	}
}

describe("buildRemoteCommand", () => {
	it("includes -n and OpenSSH ControlMaster options", async () => {
		const args = await connectionManager.buildRemoteCommand(
			{
				name: "host",
				host: "192.168.3.146",
			},
			"ls -la",
		);

		expect(args[0]).toBe("-n");
		expect(args).toContain("ControlMaster=auto");
		expect(args.at(-2)).toBe("192.168.3.146");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("still rejects missing identity files", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-ssh-key-"));
		const keyPath = path.join(dir, "missing_id_ed25519");
		try {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
				),
			).rejects.toThrow("SSH key not found");
		} finally {
			await removeWithRetries(dir);
		}
	});

	it("still rejects directory identity paths", async () => {
		const keyPath = await fs.mkdtemp(path.join(os.tmpdir(), "proto-ssh-key-"));
		try {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
				),
			).rejects.toThrow("SSH key is not a file");
		} finally {
			await removeWithRetries(keyPath);
		}
	});

	it("rejects group/world-readable identity files", async () => {
		await withLooseKey(async keyPath => {
			await expect(
				connectionManager.buildRemoteCommand(
					{
						name: "host",
						host: "192.168.3.146",
						keyPath,
					},
					"ls -la",
				),
			).rejects.toThrow("SSH key permissions must be 600 or stricter");
		});
	});
});
