import { expect, test } from "bun:test";
import { workerEnvFromParent } from "./worker-client";

test("worker subprocesses do not inherit session bridge capabilities", () => {
	const env = workerEnvFromParent({
		PI_KERNEL_BRIDGE_ADDR: "127.0.0.1:1234",
		PI_KERNEL_BRIDGE_TOKEN: "kernel-secret",
		PI_KERNEL_FLEET_ROOT: "/previous/fleet",
		PI_TOOL_BRIDGE_URL: "http://127.0.0.1:5678",
		PI_TOOL_BRIDGE_TOKEN: "tool-secret",
		PI_TOOL_BRIDGE_SESSION: "previous",
		PI_SESSION_FILE: "/previous/session.jsonl",
		PI_ARTIFACTS_DIR: "/previous/artifacts",
		PI_EVAL_LOCAL_ROOTS: "{}",
		WORKER_ENV_MARKER: "preserved",
	});

	expect(env.WORKER_ENV_MARKER).toBe("preserved");
	const sessionBridgeNames = [
		"PI_KERNEL_BRIDGE_ADDR",
		"PI_KERNEL_BRIDGE_TOKEN",
		"PI_KERNEL_FLEET_ROOT",
		"PI_TOOL_BRIDGE_URL",
		"PI_TOOL_BRIDGE_TOKEN",
		"PI_TOOL_BRIDGE_SESSION",
		"PI_SESSION_FILE",
		"PI_ARTIFACTS_DIR",
		"PI_EVAL_LOCAL_ROOTS",
	];
	expect(sessionBridgeNames.filter(name => name in env)).toEqual([]);
});
