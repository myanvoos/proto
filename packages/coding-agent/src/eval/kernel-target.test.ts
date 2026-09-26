import { expect, test } from "bun:test";
import { $which } from "@oh-my-pi/pi-utils";
import { decodeJsKernelFrame, encodeJsKernelFrame, JsKernelFrameWriter } from "./js/stdio-protocol";
import { buildKernelTargetCommand, parseKernelTarget, remoteKernelEnv } from "./kernel-target";

test("target validation rejects implicit provisioning, option injection, and host-relative working directories", () => {
	for (const target of [
		{ kind: "container", container: "-v" },
		{ kind: "container", container: "existing", image: "auto-pull" },
		{ kind: "ssh", host: "-oProxyCommand=bad" },
		{ kind: "ssh", host: "alias", cwd: "./host-relative" },
		{ kind: "ssh", host: "alias", hostCommand: [] },
		{ kind: "local", host: "alias" },
	])
		expect(() => parseKernelTarget(target)).toThrow();
});

test.skipIf(!$which("docker"))("container commands preserve opaque argv and cannot create a container", async () => {
	const command = await buildKernelTargetCommand(
		{ kind: "container", container: "existing" },
		["python3", "-c", "print('a; $HOME')"],
		{ cwd: "/tmp/remote with space", env: { VALUE: "$(touch /never)" } },
	);
	expect(command.slice(1)).toEqual([
		"exec",
		"-i",
		"--workdir",
		"/tmp/remote with space",
		"--env",
		"VALUE=$(touch /never)",
		"existing",
		"python3",
		"-c",
		"print('a; $HOME')",
	]);
});

test("remote environment cannot expose loopback bridge credentials or host filesystem roots", () => {
	const env = remoteKernelEnv({
		PI_TOOL_BRIDGE_URL: "http://127.0.0.1:1234",
		PI_TOOL_BRIDGE_TOKEN: "secret",
		PI_EVAL_LOCAL_ROOTS: '{"local":"/private"}',
		PI_SESSION_FILE: "/private/session",
		PI_ARTIFACTS_DIR: "/private/artifacts",
		PI_TOOL_BRIDGE_SESSION: "owned",
		CUSTOM: "explicit",
	});
	expect(env).toEqual({ PI_TOOL_BRIDGE_SESSION: "owned", CUSTOM: "explicit" });
});

test("stdio transport preserves binary values and rejects incompatible hosts before dispatch", () => {
	const value = { type: "tool-reply", bytes: new Uint8Array([0, 255, 128]), date: new Date(1234), nested: { n: 4n } };
	const encoded = new TextEncoder().encode(encodeJsKernelFrame(value));
	expect(decodeJsKernelFrame(encoded)).toEqual(value);
	expect(() => decodeJsKernelFrame(new TextEncoder().encode('{"version":999,"bun":"0","data":"AA=="}'))).toThrow(
		"Incompatible remote proto",
	);
});

test("stdio transport exposes write failures instead of silently losing callback replies", async () => {
	const failure = new Error("closed pipe");
	let reported: Error | undefined;
	const sink = {
		write() {
			throw failure;
		},
		flush() {
			return 0;
		},
	} as unknown as Bun.FileSink;
	const writer = new JsKernelFrameWriter(sink, error => {
		reported = error;
	});
	writer.send({ type: "tool-reply", value: 42 });
	await expect(writer.flush()).rejects.toThrow("closed pipe");
	expect(reported).toBe(failure);
	expect(() => writer.send({ type: "tool-reply" })).toThrow("closed pipe");
});
