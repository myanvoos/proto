/**
 * A completion bell should mean "the long turn you walked away from finished".
 * Sub-second turns the user watched happen, and turns that end while the
 * terminal holds keyboard focus, are noise. Focus is only honoured once the
 * host has actually reported it (DEC 1004): `undefined` means unknown, and
 * unknown must still notify.
 */
export function shouldNotifyCompletion(args: {
	elapsedMs: number;
	minSeconds: number;
	focused: boolean | undefined;
	notifyWhenFocused: boolean;
}): boolean {
	if (args.minSeconds > 0 && args.elapsedMs < args.minSeconds * 1000) return false;
	if (!args.notifyWhenFocused && args.focused === true) return false;
	return true;
}
