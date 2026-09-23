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

test("worker subprocesses drop inherited git repo-location overrides but keep an explicit overlay", () => {
	const previous = Bun.env.GIT_DIR;
	Bun.env.GIT_DIR = "/primary/.git";
	try {
		const env = workerEnvFromParent({ GIT_WORK_TREE: "/secondary", WORKER_ENV_MARKER: "kept" });
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.GIT_WORK_TREE).toBe("/secondary");
		expect(env.WORKER_ENV_MARKER).toBe("kept");
	} finally {
		if (previous === undefined) delete Bun.env.GIT_DIR;
		else Bun.env.GIT_DIR = previous;
	}
});
