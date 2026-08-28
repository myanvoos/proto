import { $env } from "@oh-my-pi/pi-utils/env";

interface BashPtyContext {
	hasUI?: boolean;
	ui?: unknown;
}

export function canUseInteractiveBashPty(pty: boolean, ctx: BashPtyContext | undefined): boolean {
	if (!pty) return false;
	if ($env.PI_NO_PTY === "1") return false;
	return ctx?.hasUI === true && ctx.ui !== undefined;
}
