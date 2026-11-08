import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";
import { disposeBashSessions } from "../exec/bash-executor";
import * as client from "../protofs/client";
import * as daemon from "../protofs/daemon";
import { protofsWorkspace } from "../task/protofs";
import type { Tool, ToolSession } from ".";
import { BashTool } from "./bash";
import { ReadTool } from "./read";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	setWorktreesDir(undefined);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("");
}

function settings(values: Record<string, unknown>): ToolSession["settings"] {
	return {
		get: (key: string) => values[key],
		getShellConfig: () => ({ env: {} }),
	} as unknown as ToolSession["settings"];
}

/**
 * A protofs checkout is the child session's cwd. A protolens device dispatched
 * inside it must resolve relative paths against the checkout, keep its typed
 * record, and `protolens://` must never be treated as a checkout path.
 */
test("a protolens device inside a protofs checkout uses the checkout cwd", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-protofs-protolens-"));
	tempDirs.push(root);
	setWorktreesDir(path.join(root, "wt"));
	const parent = path.join(root, "parent");
	const checkout = path.join(root, "checkout");
	await fs.mkdir(parent, { recursive: true });
	await fs.mkdir(checkout, { recursive: true });
	await Bun.write(path.join(parent, "same.txt"), "PARENT\n");
	await Bun.write(path.join(checkout, "same.txt"), "CHECKOUT\n");

	// Stub the daemon: the binary is not installed in the test environment.
	vi.spyOn(daemon, "startDaemon").mockResolvedValue({ socket: "/tmp/protofs-protolens.sock", mount: root });
	vi.spyOn(client, "callSocket").mockImplementation(
		async <T>(_socket: string, op: string, args: object): Promise<T> => {
			if (op === "new") {
				const name = (args as { name: string }).name;
				return { checkout: { name, path: checkout } } as T;
			}
			if (op === "rm") return {} as T;
			throw new Error(`unexpected protofs op ${op}`);
		},
	);
	const workspace = await protofsWorkspace("/opt/protofs/protofs")(parent, "ProtolensCheckout");
	expect(workspace.dir).toBe(checkout);

	const values: Record<string, unknown> = {
		"images.autoResize": false,
		"read.defaultLimit": 200,
		"fetch.enabled": false,
		"bashInterceptor.enabled": false,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"kernel.speculation.enabled": false,
		"kernel.assertPreflight.enabled": false,
		"bash.direnv": "off",
		"tools.maxTimeout": 300,
	};
	const probe: Tool = {
		name: "probe",
		label: "Probe",
		description: "Returns the supplied value.",
		parameters: type({ value: "string" }),
		async execute(_toolCallId: string, args: { value: string }) {
			return { content: [{ type: "text" as const, text: `probe:${args.value}\n` }] };
		},
	} as unknown as Tool;
	const session = {
		cwd: workspace.dir,
		settings: settings(values),
		hasUI: false,
		canPromptUser: false,
		skills: [],
		additionalDirectories: [],
		getSessionFile: () => null,
		getSessionId: () => "protofs-protolens",
		getImageAttachments: () => [],
		getArtifactsDir: () => null,
		getActiveModel: () => undefined,
		isToolActive: () => false,
	} as unknown as ToolSession;
	const read = new ReadTool(session);
	session.xdev = {
		tools: new Map<string, Tool>([
			["read", read],
			["probe", probe],
		]),
		mountedNames: new Set(["read", "probe"]),
		builtInNames: new Set(["read", "probe"]),
		isActive: () => false,
	};
	try {
		const bash = new BashTool(session);
		const result = await bash.execute("protolens-checkout-read", {
			command: `protolens read '{"path":"same.txt"}'`,
		});
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("CHECKOUT");
		expect(textOf(result)).not.toContain("PARENT");
		const device = result.details?.deviceResults?.[0];
		expect(device?.xdev).toMatchObject({ tool: "read" });
		expect(device?.isError).toBe(false);

		const listing = await read.execute("protolens-checkout-listing", { path: "protolens://" });
		expect(textOf(listing)).toContain("protolens://");
	} finally {
		await disposeBashSessions(session.cwd);
		await workspace.cleanup();
	}
});
