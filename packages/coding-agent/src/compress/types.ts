export interface CompressLoss {
	content: string;

	reason: string;
}

export interface CompressDraft {
	round: number;

	text: string;

	losses: CompressLoss[];
}

export interface CompressMetrics {
	sourceWords: number;
	draftWords: number;
	sourceTokens: number;
	draftTokens: number;

	ratio: number;
}

export type CompressStatus = "approved" | "unapproved" | "stalled" | "cancelled";

export interface CompressFileResult {
	path: string;
	status: CompressStatus;

	draft?: CompressDraft;
	metrics?: CompressMetrics;

	verdict?: string;

	rounds: number;

	outputPath?: string;
	sessionFile?: string;

	error?: string;
}

export interface CompressResult {
	exitCode: number;
	files: CompressFileResult[];

	sourceTokens: number;

	draftTokens: number;
}
