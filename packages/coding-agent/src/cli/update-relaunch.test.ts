import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import { buildRelaunchArgs } from "./update-cli";

describe("buildRelaunchArgs", () => {
	let profileSpy: Mock<() => string | undefined> | undefined;

	afterEach(() => {
		profileSpy?.mockRestore();
		profileSpy = undefined;
	});

	it("resumes the session file without a profile flag when no profile is active", () => {
		profileSpy = spyOn(piUtils, "getActiveProfile").mockReturnValue(undefined);
		expect(buildRelaunchArgs("/sessions/foo.jsonl")).toEqual(["--resume", "/sessions/foo.jsonl"]);
	});

	it("forwards the active profile ahead of --resume so the relaunched session keeps it", () => {
		profileSpy = spyOn(piUtils, "getActiveProfile").mockReturnValue("work");
		expect(buildRelaunchArgs("/sessions/foo.jsonl")).toEqual([
			"--profile",
			"work",
			"--resume",
			"/sessions/foo.jsonl",
		]);
	});

	it("omits resume flags when the quitting session has no file on disk", () => {
		profileSpy = spyOn(piUtils, "getActiveProfile").mockReturnValue(undefined);
		expect(buildRelaunchArgs(undefined)).toEqual([]);
	});
});
