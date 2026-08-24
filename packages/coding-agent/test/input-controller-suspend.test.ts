import { afterEach, describe, expect, it, type Mock, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface SuspendCtx {
	ctx: InteractiveModeContext;
	ui: {
		start: Mock<() => void>;
		stop: Mock<() => void>;
		requestRender: Mock<(force?: boolean) => void>;
	};
	showStatus: Mock<(message: string) => void>;
	showError: Mock<(message: string) => void>;
}

function createCtx(): SuspendCtx {
	const ui = {
		start: vi.fn(),
		stop: vi.fn(),
		requestRender: vi.fn(),
	};
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		ui: ui as unknown as InteractiveModeContext["ui"],
		showStatus,
		showError,
	} as unknown as InteractiveModeContext;
	return { ctx, ui, showStatus, showError };
}

let sigcontListener: (() => void) | undefined;

function spyOnProcessOnce(): Mock<(event: NodeJS.Signals | string, listener: () => void) => NodeJS.Process> {
	return vi.spyOn(process, "once") as unknown as Mock<
		(event: NodeJS.Signals | string, listener: () => void) => NodeJS.Process
	>;
}

afterEach(() => {
	if (sigcontListener) process.removeListener("SIGCONT", sigcontListener);
	sigcontListener = undefined;
	vi.restoreAllMocks();
});

describe("InputController.handleCtrlZ", () => {
	it("SIGSTOPs the foreground process group and registers a SIGCONT resume hook on POSIX (#3461)", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		const onceSpy = spyOnProcessOnce();
		const { ctx, ui, showError } = createCtx();

		const controller = new InputController(ctx);
		controller.handleCtrlZ();

		// Resume hook registered BEFORE the signal is sent so a same-tick
		// SIGCONT delivery can't race past us.
		expect(onceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		const sigcontOrder = onceSpy.mock.invocationCallOrder[0] ?? Infinity;
		const stopOrder = ui.stop.mock.invocationCallOrder[0] ?? Infinity;
		const killOrder = killSpy.mock.invocationCallOrder[0] ?? Infinity;
		expect(sigcontOrder).toBeLessThan(stopOrder);
		expect(stopOrder).toBeLessThan(killOrder);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(killSpy).toHaveBeenCalledWith(0, "SIGSTOP");
		expect(ui.start).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();

		// Simulating the kernel-delivered SIGCONT drives the TUI back up.
		sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
		expect(sigcontListener).toBeDefined();
		sigcontListener?.();
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
	});

	it("restores the TUI and drops the SIGCONT listener when process.kill rejects the signal", () => {
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("Unknown signal: SIGSTOP");
		});
		const onceSpy = spyOnProcessOnce();
		const removeSpy = vi.spyOn(process, "removeListener");
		const { ctx, ui, showError, showStatus } = createCtx();

		const controller = new InputController(ctx);
		// Critical contract: the failure must not bubble up to the caller —
		// otherwise the TUI's stdin reader (which invoked us) crashes the
		// whole process via `[Uncaught Exception]`.
		expect(() => controller.handleCtrlZ()).not.toThrow();

		// The exact listener we registered for SIGCONT is the one we
		// remove; otherwise a leaked handler would fire on the next
		// unrelated continue and re-`start()` an already-running TUI.
		sigcontListener = onceSpy.mock.calls.find(([sig]) => sig === "SIGCONT")?.[1];
		expect(sigcontListener).toBeDefined();
		expect(removeSpy).toHaveBeenCalledWith("SIGCONT", sigcontListener);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls[0]?.[0]).toMatch(/Failed to suspend/);
		expect(showStatus).not.toHaveBeenCalled();
	});
});
