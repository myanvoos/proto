import { afterEach, expect, test } from "bun:test";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./local-protocol";

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
