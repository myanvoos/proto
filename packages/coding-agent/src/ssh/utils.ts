export function sanitizeHostName(name: string): string {
	const sanitized = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
	return sanitized.length > 0 ? sanitized : "remote";
}

export function buildSshTarget(username: string | undefined, host: string): string {
	if (host.startsWith("-")) {
		throw new Error(
			`Invalid SSH host "${host}": an SSH destination must not begin with "-" (argument-injection guard)`,
		);
	}
	if (username?.startsWith("-")) {
		throw new Error(
			`Invalid SSH username "${username}": an SSH username must not begin with "-" (argument-injection guard)`,
		);
	}
	return username ? `${username}@${host}` : host;
}

export function quotePosixPath(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function wrapInPosixShell(shell: "sh" | "bash" | "zsh", command: string): string {
	return `${shell} -c ${quotePosixPath(command)}`;
}
