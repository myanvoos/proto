export const ESC = "\x1b";

export const CSI = `${ESC}[`;

export const OSC = `${ESC}]`;

export const BEL = "\x07";

export const ST = `${ESC}\\`;

export const SGR_RESET = `${CSI}0m`;

export const SGR_RESET_SHORT = `${CSI}m`;

export const SGR_FG_RESET = `${CSI}39m`;

export const SGR_BG_RESET = `${CSI}49m`;

export const SGR_INTENSITY_RESET = `${CSI}22m`;

export const OSC66 = `${OSC}66;`;

export const SGR_SEQUENCE_PATTERN = "\\x1b\\[([0-9;:]*)m";

export function sgrSequence(flags: string): RegExp {
	return new RegExp(SGR_SEQUENCE_PATTERN, flags);
}
