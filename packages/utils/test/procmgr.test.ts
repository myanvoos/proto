import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "../src/dirs";
import { getShellArgs, getShellConfig } from "../src/procmgr";

describe("getShellConfig", () => {
	it("directs invalid custom shell paths to the canonical config file", () => {
		const missingShell = path.join(os.tmpdir(), `proto-missing-shell-${process.pid}`, "bash");
		const configPath = path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
		expect(() => getShellConfig(missingShell)).toThrow(
			`Custom shell path not found: ${missingShell}\nPlease update shellPath in ${configPath}`,
		);
	});
});

describe("getShellArgs", () => {
	it("uses -Command for pwsh instead of the POSIX -l -c pair", () => {
		// `pwsh -l -c <cmd>` parses `-l` as the command and fails with
		// `The term '-l' is not recognized`, breaking every spawn path for a
		// shellPath pointed at PowerShell.
		expect(getShellArgs("/usr/bin/pwsh", {})).toEqual(["-NoLogo", "-Command"]);
	});

	it("maps the no-login env gate to -NoProfile for pwsh", () => {
		expect(getShellArgs("pwsh", { PI_BASH_NO_LOGIN: "1" })).toEqual(["-NoLogo", "-NoProfile", "-Command"]);
	});

	it("uses POSIX args for POSIX shells", () => {
		expect(getShellArgs("/bin/bash", {})).toEqual(["-l", "-c"]);
		expect(getShellArgs("/bin/bash", { PI_BASH_NO_LOGIN: "1" })).toEqual(["-c"]);
	});
});
