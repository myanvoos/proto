import RUNNER_SCRIPT from "./runner.py" with { type: "text" };
import STATE_SCRIPT from "./state.py" with { type: "text" };

// One embedded asset keeps compiled CLI and remote-target staging self-contained.
export const PYTHON_RUNNER_SOURCE = RUNNER_SCRIPT.replace(
	"_PERSISTENCE_SOURCE = None",
	() => `_PERSISTENCE_SOURCE = ${JSON.stringify(STATE_SCRIPT)}`,
);
