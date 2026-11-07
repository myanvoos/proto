/**
 * The agent pins `LANG`/`LC_ALL=C.UTF-8` for its own bash commands so sort order, number formats, and tool messages do
 * not vary by machine. A locale the command itself supplies (env overrides or direnv) opts out, and user `!` commands
 * keep the launcher's locale.
 */
import { describe, expect, it } from "bun:test";
import { buildNonInteractiveEnv } from "./non-interactive-env";

describe("buildNonInteractiveEnv locale pinning", () => {
	it("pins the agent locale over an inherited one", () => {
		const env = buildNonInteractiveEnv(undefined, { baseEnv: { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" } });

		expect(env.LANG).toBe("C.UTF-8");
		expect(env.LC_ALL).toBe("C.UTF-8");
	});

	it("lets a per-command locale replace the pinned default", () => {
		const env = buildNonInteractiveEnv({ LC_CTYPE: "en_US.UTF-8" }, { baseEnv: { LANG: "de_DE.UTF-8" } });

		// A locale anywhere in the command env opts out entirely, so the command's
		// own collation wins instead of a half-pinned mix.
		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
		expect(env.LC_CTYPE).toBe("en_US.UTF-8");
	});

	it("keeps the inherited locale for user-shell commands", () => {
		const env = buildNonInteractiveEnv(undefined, {
			baseEnv: { LANG: "de_DE.UTF-8" },
			inheritLocale: true,
		});

		expect(env.LANG).toBeUndefined();
		expect(env.LC_ALL).toBeUndefined();
	});
});
