import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "./client";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "proto-broker-hints-"));
const project = path.join(tmp, "project");
await fs.mkdir(project);
const client = await createDaemonBrokerClient(project, { runtimeDir: path.join(tmp, "run") });

test("an unknown process name suggests the closest known names without dumping the whole roster", async () => {
	const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "web-api"];
	for (const name of names) {
		await client.request({
			op: "start",
			spec: {
				name,
				application: "bash",
				args: ["-c", "true"],
				env: {},
				cwd: project,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		});
	}

	const error = await client.request({ op: "describe", name: "web-apo" }).catch((cause: unknown) => cause);
	const message = error instanceof Error ? error.message : String(error);

	expect(message).toContain("Unknown daemon web-apo");
	const listed = message.slice(message.indexOf("Closest known: ") + "Closest known: ".length).split(" (+")[0]!;
	const suggested = listed.split(", ");
	expect(suggested[0]).toBe("web-api");
	expect(suggested).toHaveLength(8);
	expect(message).toContain("(+3 more)");
	expect(message.length).toBeLessThan(200);
}, 60_000);

afterAll(async () => {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await fs.rm(tmp, { recursive: true, force: true });
});
