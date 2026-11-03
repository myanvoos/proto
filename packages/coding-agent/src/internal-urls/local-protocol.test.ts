import { afterEach, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { LocalProtocolHandler, type LocalProtocolOptions, resolveLocalRoot } from "./local-protocol";

afterEach(() => LocalProtocolHandler.resetOverrideForTests());

test("protocol overrides retain the newest live session under out-of-order disposal", () => {
	const first: LocalProtocolOptions = { getSessionId: () => "first" };
	const second: LocalProtocolOptions = { getSessionId: () => "second" };
	const releaseFirst = LocalProtocolHandler.setOverride(first);
	const releaseSecond = LocalProtocolHandler.setOverride(second);

	expect(LocalProtocolHandler.resolveOptions()).toBe(second);
	releaseFirst();
	expect(LocalProtocolHandler.resolveOptions()).toBe(second);
	releaseSecond();

	const releaseFirstAgain = LocalProtocolHandler.setOverride(first);
	const releaseSecondAgain = LocalProtocolHandler.setOverride(second);
	releaseSecondAgain();
	expect(LocalProtocolHandler.resolveOptions()).toBe(first);
	releaseFirstAgain();
});

test("dot session identities cannot move fallback local storage outside its per-session root", () => {
	for (const id of [".", "..", ""]) {
		expect(resolveLocalRoot({ getSessionId: () => id })).toBe(path.join(os.tmpdir(), "proto-local", "session"));
	}
});
