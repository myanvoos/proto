import { Text } from "@oh-my-pi/pi-tui";
import type { BackgroundSideDispatchDetails, CustomMessage } from "../../session/messages";
import { replaceTabs } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { TranscriptBlock } from "./transcript-container";

const SIDE_WORK_PREVIEW_LENGTH = 56;

function previewWork(work: string): string {
	const singleLine = replaceTabs(work).trim().replace(/\s+/g, " ");
	if (singleLine.length <= SIDE_WORK_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, SIDE_WORK_PREVIEW_LENGTH - 1)}…`;
}

export function createBackgroundSideDispatchBlock(message: CustomMessage<unknown>): TranscriptBlock {
	const details = (message as CustomMessage<Partial<BackgroundSideDispatchDetails>>).details;
	const jobId = details?.jobId ?? "unknown";
	const work = details?.work ? previewWork(details.work) : undefined;
	const line = [
		theme.fg("muted", `${theme.icon.output} Side agent dispatched`),
		theme.fg("dim", "[task]"),
		theme.fg("accent", jobId),
		work ? theme.fg("dim", `${theme.format.dash} ${work}`) : undefined,
	]
		.filter(Boolean)
		.join(" ");
	const block = new TranscriptBlock();
	block.addChild(new Text(line, 1, 0));
	return block;
}
