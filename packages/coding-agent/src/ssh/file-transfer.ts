import { ptree } from "@oh-my-pi/pi-utils";
import { ConcatSink } from "@oh-my-pi/pi-utils/stream";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { quotePosixPath, wrapInPosixShell } from "./utils";

const DEFAULT_TIMEOUT_MS = 30_000;
const remoteHomes = new Map<string, string>();

async function ensurePosixRemote(target: SSHConnectionTarget): Promise<"sh" | "bash" | "zsh"> {
	await ensureConnection(target);
	const info = await ensureHostInfo(target);
	if (!info.transferShell) {
		throw new Error(
			`ssh://: ${target.name} has no verified POSIX shell for ssh:// read/write — none of sh/bash/zsh round-tripped a capability probe (use \`bash\` with a remote SSH command for this host)`,
		);
	}
	return info.transferShell;
}

interface RemoteFileReadOptions {
	maxBytes: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

interface RemoteFileReadResult {
	bytes: Uint8Array;

	truncated: boolean;
}

interface RemoteFileWriteOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function remoteHomeDirectory(
	target: SSHConnectionTarget,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
	opts.signal?.throwIfAborted();
	const key = JSON.stringify([target.name, target.host, target.username, target.port, target.keyPath]);
	const cached = remoteHomes.get(key);
	if (cached !== undefined) return cached;
	const shell = await ensurePosixRemote(target);
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, `printf '%s' "$HOME"`));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const home = new TextDecoder("utf-8", { fatal: true }).decode(await child.bytes());
	await child.exitedCleanly;
	if (!home.startsWith("/") || home.includes("\0")) {
		throw new Error(`ssh://: ${target.name} did not return an absolute remote HOME`);
	}
	remoteHomes.set(key, home);
	return home;
}

export async function readRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: RemoteFileReadOptions,
): Promise<RemoteFileReadResult> {
	const shell = await ensurePosixRemote(target);
	const command = `head -c ${opts.maxBytes + 1} ${quotePosixPath(remotePath)}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});

	const raw = await child.bytes();
	await child.exitedCleanly;
	const truncated = raw.length > opts.maxBytes;
	return { bytes: truncated ? raw.subarray(0, opts.maxBytes) : raw, truncated };
}

export async function writeRemoteFile(
	target: SSHConnectionTarget,
	remotePath: string,
	content: Uint8Array,
	opts: RemoteFileWriteOptions,
): Promise<void> {
	const shell = await ensurePosixRemote(target);
	if (remotePath.endsWith("/")) {
		throw new Error("ssh://: destination is a directory path (trailing '/'); ssh:// write requires a file path");
	}
	const dest = quotePosixPath(remotePath);
	const tmp = quotePosixPath(`${remotePath}.proto-tmp.${crypto.randomUUID()}`);

	const command =
		`t=${tmp}; trap 'rm -f -- "$t"' 0; ` +
		`mkdir -p -- "$(dirname "$t")" && ` +
		`cat > "$t" && { ` +
		`if [ -d ${dest} ]; then echo 'ssh://: destination is a directory' >&2; exit 1; ` +
		`elif [ -f ${dest} ] && [ ! -L ${dest} ]; then cat "$t" > ${dest} || exit 1; ` +
		`elif [ -e ${dest} ] && [ ! -L ${dest} ]; then echo 'ssh://: destination is a special file (not a regular file)' >&2; exit 1; ` +
		`else mv "$t" ${dest}; fi; ` +
		`}`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command), { allowStdin: true });
	using child = ptree.spawn(["ssh", ...args], {
		stdin: content,
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	await child.exitedCleanly;
}

export type RemotePathKind = "file" | "directory" | "other" | "missing";

export async function statRemotePath(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemotePathKind> {
	const shell = await ensurePosixRemote(target);
	const p = quotePosixPath(remotePath);
	const command = `if [ -d ${p} ]; then echo directory; elif [ -f ${p} ]; then echo file; elif [ -e ${p} ]; then echo other; else echo missing; fi`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const out = new TextDecoder().decode(await child.bytes()).trim();
	await child.exitedCleanly;
	return out === "directory" || out === "file" || out === "other" ? out : "missing";
}

export interface RemoteDirEntry {
	name: string;

	isDirectory: boolean;
}

export async function listRemoteDir(
	target: SSHConnectionTarget,
	remotePath: string,
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemoteDirEntry[]> {
	const shell = await ensurePosixRemote(target);
	const classify = `for p do if [ -d "$p" ]; then t=dir; else t=file; fi; printf '%s\\000%s\\000' "$t" "\${p#./}"; done`;
	const command = `cd ${quotePosixPath(remotePath)} && LC_ALL=C find . ! -name . -prune -exec ${shell} -c ${quotePosixPath(classify)} ${shell} {} +`;
	const args = await buildRemoteCommand(target, wrapInPosixShell(shell, command));
	using child = ptree.spawn(["ssh", ...args], {
		signal: ptree.combineSignals(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
	});
	const buffer = new ConcatSink();
	let size = 0;
	for await (const chunk of child.proc.stdout) {
		size += chunk.length;
		if (size > 1024 * 1024)
			throw new Error("ssh://: directory listing exceeds the 1 MiB limit; use a narrower directory scope");
		buffer.append(chunk);
	}
	await child.exitedCleanly;
	const fields = new TextDecoder("utf-8", { fatal: true }).decode(buffer.flush()).split("\0");
	if (fields.pop() !== "" || fields.length % 2 !== 0) throw new Error("ssh://: malformed directory listing");
	const entries: RemoteDirEntry[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const type = fields[index];
		const name = fields[index + 1];
		if ((type !== "dir" && type !== "file") || !name || name.includes("/") || name === "." || name === "..") {
			throw new Error("ssh://: invalid directory entry");
		}
		entries.push({ name, isDirectory: type === "dir" });
	}

	entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
	return entries;
}
