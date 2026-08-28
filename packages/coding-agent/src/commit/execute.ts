import * as git from "../utils/git";

export class CommitAbortedError extends Error {
	constructor() {
		super("commit aborted");
		this.name = "CommitAbortedError";
	}
}

export function abortOnGitFailure(context: string, error: git.GitCommandError, note?: string): never {
	const detail = error.result.stderr.trim() || error.result.stdout.trim() || error.message;
	const body = detail
		.split("\n")
		.map(line => `    ${line}`)
		.join("\n");
	process.stderr.write(`✗ ${context}:\n${body}\n`);
	if (note) process.stderr.write(`  ${note}\n`);
	throw new CommitAbortedError();
}

export async function pushOrAbort(cwd: string): Promise<void> {
	try {
		await git.push(cwd);
	} catch (error) {
		if (error instanceof git.GitCommandError) abortOnGitFailure("Push failed", error);
		throw error;
	}
	process.stdout.write("Pushed to remote.\n");
}
