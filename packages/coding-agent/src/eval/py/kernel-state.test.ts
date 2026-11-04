import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { stageRunnerScript } from "../runner-cache";
import { checkPythonKernelAvailability, PythonKernel } from "./kernel";
import { PYTHON_REMOTE_RUNNER_SOURCE } from "./runner-source";

const FIRST_CELL = `assert not {"os", "sys", "__proto_env", "__proto_cwd"}.intersection(globals())
assert not any(name.startswith("__proto_") for name in globals())
assert "namespace-secret" not in repr(globals())
import proto_harness as harness
assert harness.kernel_state()["executionCount"] == 1
assert not hasattr(harness, "save_state") and not hasattr(harness, "load_state")
value = 41
print("clean namespace")`;

test("named Python startup exposes no automatic helpers or environment secrets and counts its first user cell as one", async () => {
	using directory = TempDir.createSync("@python-state-clean-");
	const kernel = await PythonKernel.start({ cwd: directory.path(), env: { PROTO_TEST_SECRET: "namespace-secret" } });
	try {
		expect((await kernel.requestStatus(5_000))?.executionCount).toBe(0);
		const first = await kernel.execute(FIRST_CELL);
		expect(first.status, JSON.stringify(first.error)).toBe("ok");
		expect(first.executionCount).toBe(1);
		const next = await kernel.execute(`assert value == 41
assert harness.defs()["value"] == 1
assert harness.kernel_state()["executionCount"] == 2
assert __import__("os").path.samefile(__import__("os").getcwd(), ${JSON.stringify(directory.path())})`);
		expect(next.status, JSON.stringify(next.error)).toBe("ok");
	} finally {
		expect((await kernel.shutdown()).confirmed).toBe(true);
	}
}, 30_000);

test("standalone remote runner binds the explicit warm API before the first user cell without a prelude request", async () => {
	using directory = TempDir.createSync("@python-state-standalone-");
	const available = await checkPythonKernelAvailability(directory.path());
	if (!available.ok || !available.pythonPath) throw new Error(available.reason);
	const script = await stageRunnerScript("proto-python-standalone", "py", PYTHON_REMOTE_RUNNER_SOURCE);
	const kernel = new PythonKernel(`standalone-${crypto.randomUUID()}`);
	kernel.setProcess(
		Bun.spawn([available.pythonPath, "-S", "-u", script], {
			cwd: directory.path(),
			env: { ...process.env, PROTO_TEST_SECRET: "namespace-secret", PYTHONPATH: "" },
			detached: true,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	try {
		expect((await kernel.requestStatus(5_000))?.executionCount).toBe(0);
		const first = await kernel.execute(FIRST_CELL);
		expect(first.status, JSON.stringify(first.error)).toBe("ok");
		expect(first.executionCount).toBe(1);
	} finally {
		expect((await kernel.shutdown()).confirmed).toBe(true);
	}
}, 30_000);
