export interface StreamInfo {
	mimetype?: string;
	extension?: string;
	charset?: string;
	filename?: string;
	localPath?: string;
	url?: string;

	imageDir?: string;
}

export interface ConversionResult {
	markdown: string;
	title?: string;
}

export interface MarkitOptions {
	describe?: (image: Buffer, mimetype: string) => Promise<string>;

	transcribe?: (audio: Buffer, mimetype: string) => Promise<string>;

	prompt?: string;
}

export interface Converter {
	name: string;

	accepts(streamInfo: StreamInfo): boolean;

	convert(input: Buffer, streamInfo: StreamInfo, options?: MarkitOptions): Promise<ConversionResult>;
}
