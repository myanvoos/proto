import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import init from "./proto_harness/__init__.py" with { type: "text" };
import client from "./proto_harness/_client.py" with { type: "text" };
import display from "./proto_harness/_display.py" with { type: "text" };
import filesystem from "./proto_harness/fs.py" with { type: "text" };
import helpers from "./proto_harness/helpers.py" with { type: "text" };
import kernel from "./proto_harness/kernel.py" with { type: "text" };
import output from "./proto_harness/output.py" with { type: "text" };
import { PYTHON_SERIALIZATION_ASSETS } from "./serialization-assets";
import sitecustomize from "./sitecustomize.py" with { type: "text" };

/** Explicit imports keep source, npm bundle, and compiled binaries self-contained. */
export const PYTHON_RUNTIME_ASSETS: Readonly<Record<string, string>> = {
	"sitecustomize.py": sitecustomize,
	"proto_harness/__init__.py": init,
	"proto_harness/_client.py": client,
	"proto_harness/_display.py": display,
	"proto_harness/fs.py": filesystem,
	"proto_harness/helpers.py": helpers,
	"proto_harness/kernel.py": kernel,
	"proto_harness/output.py": output,
	...PYTHON_SERIALIZATION_ASSETS,
};

let staging: Promise<string> | undefined;
let stagedRoot: string | undefined;

/** Private per-host runtime, not installed into any user interpreter. */
export function stagePythonRuntimeAssets(): Promise<string> {
	staging ??= (async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "proto-python-runtime-"));
		try {
			await fs.chmod(root, 0o700);
			for (const [name, source] of Object.entries(PYTHON_RUNTIME_ASSETS)) {
				const target = path.join(root, name);
				await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
				const file = await fs.open(target, "wx", 0o600);
				try {
					await file.writeFile(source);
				} finally {
					await file.close();
				}
			}
			stagedRoot = root;
			return root;
		} catch (error) {
			staging = undefined;
			await fs.rm(root, { recursive: true, force: true });
			throw error;
		}
	})();
	return staging;
}

process.once("exit", () => {
	if (stagedRoot) removeSyncWithRetries(stagedRoot);
});
