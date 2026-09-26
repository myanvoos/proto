import { $env, $which, readBytesWithLimit } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import { buildRemoteCommand, ensureSshControlDir } from "../ssh/connection-manager";
import { quotePosixPath, wrapInPosixShell } from "../ssh/utils";

interface RemoteKernelOptions {
	/** Absolute path in the target filesystem, never resolved on the parent. */
	cwd?: string;
	interpreter?: string;
	/** Installed compatible proto CLI (or interpreter + CLI entry). Nothing is installed implicitly. */
	hostCommand?: string[];
}

export type KernelTarget =
	| { kind: "local" }
	| ({ kind: "container"; container: string; engine?: "docker" | "podman" } & RemoteKernelOptions)
	| ({ kind: "ssh"; host: string } & RemoteKernelOptions);

export function parseKernelTarget(value: unknown): KernelTarget {
	if (value === undefined) return { kind: "local" };
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Kernel target must be an object");
	const target = value as Record<string, unknown>;
	const allowed =
		target.kind === "local"
			? ["kind"]
			: target.kind === "container"
				? ["kind", "container", "engine", "cwd", "interpreter", "hostCommand"]
				: target.kind === "ssh"
					? ["kind", "host", "cwd", "interpreter", "hostCommand"]
					: undefined;
	if (!allowed) throw new Error("Kernel target kind must be local, container, or ssh");
	for (const key of Object.keys(target))
		if (!allowed.includes(key)) throw new Error(`Unknown kernel target field: ${key}`);
	for (const key of ["cwd", "interpreter", "container", "host"]) {
		const item = target[key];
		if (item !== undefined && (typeof item !== "string" || !item.trim() || /[\0\r\n]/u.test(item))) {
			throw new Error(`Kernel target ${key} must be a nonempty string without NUL or newlines`);
		}
	}
	if (target.kind === "container" && (typeof target.container !== "string" || target.container.startsWith("-"))) {
		throw new Error("Kernel container target requires an existing container name or ID (not an option)");
	}
	if (target.kind === "ssh" && (typeof target.host !== "string" || target.host.startsWith("-"))) {
		throw new Error("Kernel SSH target requires a configured host or OpenSSH destination (not an option)");
	}
	if (target.engine !== undefined && target.engine !== "docker" && target.engine !== "podman") {
		throw new Error("Kernel container engine must be docker or podman");
	}
	if (typeof target.cwd === "string" && !target.cwd.startsWith("/"))
		throw new Error("Remote kernel cwd must be an absolute target path");
	if (
		target.hostCommand !== undefined &&
		(!Array.isArray(target.hostCommand) ||
			target.hostCommand.length === 0 ||
			target.hostCommand.some(item => typeof item !== "string" || !item || /[\0\r\n]/u.test(item)))
	) {
		throw new Error("Kernel hostCommand must be a nonempty executable argv array");
	}
	return structuredClone(
		Object.fromEntries(allowed.filter(key => target[key] !== undefined).map(key => [key, target[key]])),
	) as KernelTarget;
}

export function kernelTargetCwd(target: KernelTarget, cwd: string): string {
	if (target.kind === "local") return cwd;
	const remoteCwd = target.cwd ?? cwd;
	if (!remoteCwd.startsWith("/") || /[\0\r\n]/u.test(remoteCwd))
		throw new Error("Remote kernel cwd must be an absolute target path");
	return remoteCwd;
}

export function kernelTargetLabel(target: KernelTarget): string {
	if (target.kind === "local") return "local";
	return target.kind === "container" ? `${target.engine ?? "docker"}:${target.container}` : `ssh:${target.host}`;
}

/** Transport credentials stay on the parent; no parent environment is exported to the target. */
export function kernelTransportEnv(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SSH_AUTH_SOCK",
		"XDG_RUNTIME_DIR",
		"DOCKER_HOST",
		"DOCKER_CONTEXT",
		"DOCKER_CONFIG",
		"CONTAINER_HOST",
		"CONTAINER_CONNECTION",
		"TMPDIR",
		"LANG",
		"LC_ALL",
	]) {
		const value = $env[name];
		if (typeof value === "string") result[name] = value;
	}
	return result;
}

export function remoteKernelEnv(env: Record<string, string | undefined> = {}): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		// Parent-only paths and broad loopback credentials must never be sent remotely.
		if (
			name === "PI_TOOL_BRIDGE_URL" ||
			name === "PI_TOOL_BRIDGE_TOKEN" ||
			name === "PI_SESSION_FILE" ||
			name === "PI_ARTIFACTS_DIR"
		)
			continue;
		if (typeof value !== "string") continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || value.includes("\0"))
			throw new Error(`Invalid target environment variable: ${name}`);
		result[name] = value;
	}
	return result;
}

export interface KernelTargetCommandOptions {
	cwd: string;
	/** Parent project directory used solely for SSH capability discovery. */
	discoveryCwd?: string;
	env?: Record<string, string>;
}

/** Compose argv with existing SSH hardening/quoting; never run a local shell wrapper. */
export async function buildKernelTargetCommand(
	targetValue: KernelTarget,
	command: string[],
	options: KernelTargetCommandOptions,
): Promise<string[]> {
	const target = parseKernelTarget(targetValue);
	if (command.length === 0 || command.some(part => part.includes("\0")))
		throw new Error("Invalid kernel target command");
	if (target.kind === "local") return command;
	const cwd = kernelTargetCwd(target, options.cwd);
	const env = remoteKernelEnv(options.env);
	if (target.kind === "container") {
		const engine = target.engine ?? "docker";
		const executable = $which(engine);
		if (!executable)
			throw new Error(
				`Kernel target requires installed ${engine}; no container or runtime is provisioned automatically`,
			);
		return [
			executable,
			"exec",
			"-i",
			"--workdir",
			cwd,
			...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
			target.container,
			...command,
		];
	}
	const executable = $which("ssh");
	if (!executable) throw new Error("Kernel target requires an installed OpenSSH client");
	const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, {
		cwd: options.discoveryCwd ?? options.cwd,
	});
	const host = items.find(item => item.name === target.host) ?? { name: target.host, host: target.host };
	ensureSshControlDir();
	const invocation = [
		...(Object.keys(env).length ? ["env", ...Object.entries(env).map(([key, value]) => `${key}=${value}`)] : []),
		...command,
	]
		.map(quotePosixPath)
		.join(" ");
	const script = `cd ${quotePosixPath(cwd)} && exec ${invocation}`;
	return [
		executable,
		"-T",
		"-o",
		"ForwardAgent=no",
		"-o",
		"ForwardX11=no",
		"-o",
		"ClearAllForwardings=yes",
		"-o",
		"ConnectTimeout=10",
		...(await buildRemoteCommand(host, wrapInPosixShell("sh", script), { allowStdin: true })),
	];
}

export interface KernelTargetProcess {
	proc: Subprocess<"pipe", "pipe", "pipe">;
	/** Confirms target process group termination, not merely local ssh/docker exit. */
	terminate(): Promise<boolean>;
	interrupt(): Promise<void>;
}

/** Every remote process owns a private control directory and process group. Requires POSIX sh + setsid. */
export async function spawnKernelTarget(
	target: KernelTarget,
	command: string[],
	options: KernelTargetCommandOptions,
): Promise<KernelTargetProcess> {
	if (target.kind === "local") throw new Error("spawnKernelTarget requires an explicit remote target");
	const controlDir = `/tmp/proto-kernel-${crypto.randomUUID()}`;
	const pidFile = `${controlDir}/pid`;
	const start = `umask 077; mkdir ${quotePosixPath(controlDir)} || exit 1; command -v setsid >/dev/null || { rmdir ${quotePosixPath(controlDir)}; echo 'Remote kernels require setsid' >&2; exit 127; }; exec setsid -w sh -c ${quotePosixPath(`printf '%s\n' "$$" > ${quotePosixPath(pidFile)}; exec "$@"`)} sh "$@"`;
	const argv = await buildKernelTargetCommand(target, ["sh", "-c", start, "sh", ...command], options);
	const proc = Bun.spawn(argv, {
		env: kernelTransportEnv(),
		detached: true,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let terminating: Promise<boolean> | undefined;
	const runControl = async (script: string): Promise<boolean> => {
		const argv = await buildKernelTargetCommand({ ...target, cwd: "/" }, ["sh", "-c", script], {
			...options,
			cwd: "/",
			env: {},
		});
		const stop = Bun.spawn(argv, { env: kernelTransportEnv(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
		const timer = setTimeout(() => stop.kill("SIGKILL"), 15_000);
		const drained = readBytesWithLimit(stop.stderr, 16 * 1024);
		try {
			const code = await stop.exited;
			await drained;
			return code === 0;
		} finally {
			clearTimeout(timer);
		}
	};
	const handle: KernelTargetProcess = {
		proc,
		async interrupt() {
			const script = `read -r pid < ${quotePosixPath(pidFile)}; case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -INT "-$pid"`;
			if (!(await runControl(script)))
				throw new Error(`Failed to interrupt kernel target ${kernelTargetLabel(target)}`);
		},
		terminate() {
			terminating ??= (async () => {
				// The tokenized path belongs only to this launch. Never touch the container itself.
				const cleanup = `if [ ! -d ${quotePosixPath(controlDir)} ]; then exit 0; fi; if [ ! -f ${quotePosixPath(pidFile)} ]; then rmdir ${quotePosixPath(controlDir)}; exit $?; fi; read -r pid < ${quotePosixPath(pidFile)}; case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -TERM "-$pid" 2>/dev/null || :; n=0; while kill -0 "-$pid" 2>/dev/null && [ "$n" -lt 20 ]; do sleep 0.05; n=$((n+1)); done; kill -KILL "-$pid" 2>/dev/null || :; n=0; while kill -0 "-$pid" 2>/dev/null && [ "$n" -lt 20 ]; do sleep 0.05; n=$((n+1)); done; if kill -0 "-$pid" 2>/dev/null; then exit 1; fi; rm ${quotePosixPath(pidFile)} && rmdir ${quotePosixPath(controlDir)}`;
				try {
					if (!(await runControl(cleanup))) return false;
					try {
						proc.kill("SIGKILL");
					} catch {}
					await proc.exited;
					return true;
				} catch {
					return false;
				}
			})().then(confirmed => {
				if (!confirmed) terminating = undefined;
				return confirmed;
			});
			return terminating;
		},
	};
	// A crashed runtime can leave live descendants even after ssh/docker reports exit.
	void proc.exited.then(() => handle.terminate());
	return handle;
}
