import { BINARY_NAME, getActiveProfile } from "@oh-my-pi/pi-utils";

export function resumeCommand(sessionId: string): string {
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	return `${BINARY_NAME} ${profileFlag}--resume ${sessionId}`;
}
