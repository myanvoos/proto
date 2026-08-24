import { afterEach, describe, expect, it } from "bun:test";
import { canUseInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-pty-selection";

const originalNoPty = Bun.env.PI_NO_PTY;

function setNoPty(value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env.PI_NO_PTY;
		return;
	}
	Bun.env.PI_NO_PTY = value;
}

function interactiveContext() {
	return { hasUI: true, ui: {} };
}

describe("bash PTY selection", () => {
	afterEach(() => {
		setNoPty(originalNoPty);
	});

	it("allows interactive PTY when requested with UI and not disabled", () => {
		setNoPty(undefined);

		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(true);
		expect(canUseInteractiveBashPty(true, undefined)).toBe(false);

		setNoPty("1");
		expect(canUseInteractiveBashPty(true, interactiveContext())).toBe(false);
	});

	it("disables interactive PTY when pty is false", () => {
		expect(canUseInteractiveBashPty(false, interactiveContext())).toBe(false);
	});
});
