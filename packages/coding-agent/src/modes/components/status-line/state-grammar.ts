import { theme } from "../../theme/theme";

function dot(): string {
	return theme.sep.dot.trim();
}

export function stateSeparator(): string {
	return theme.fg("dim", ` ${dot()} `);
}

export function segmentSeparator(): string {
	return theme.fg("dim", `  ${dot()}  `);
}
