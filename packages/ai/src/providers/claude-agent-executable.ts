/** Compiled builds replace this module with the target platform's embedded SDK executable. */
export function claudeAgentExecutable(): string | undefined {
	return process.env.PI_CLAUDE_EXECUTABLE;
}
