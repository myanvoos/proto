import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import { PYTHON_RUNTIME_ASSETS } from "./runtime-assets";

// One embedded asset keeps compiled CLI and remote-target staging self-contained.
export const PYTHON_RUNNER_SOURCE = RUNNER_SCRIPT;
export const PYTHON_REMOTE_RUNNER_SOURCE = RUNNER_SCRIPT.replace(
	"_PYTHON_PACKAGE_ASSETS = None",
	() => `_PYTHON_PACKAGE_ASSETS = ${JSON.stringify(PYTHON_RUNTIME_ASSETS)}`,
);
