/** Encoded wire/source bytes and conservative RGBA terminal residency estimates. */
export interface TerminalImageLimits {
	imageBytes: number;
	sourceBytes: number;
	queuedBytes: number;
	residentBytes: number;
	residentCount: number;
	pixels: number;
}

export const TERMINAL_IMAGE_LIMITS: TerminalImageLimits = {
	imageBytes: 8 * 1024 * 1024,
	sourceBytes: 64 * 1024 * 1024,
	queuedBytes: 32 * 1024 * 1024,
	residentBytes: 256 * 1024 * 1024,
	residentCount: 128,
	pixels: 32_000_000,
};
