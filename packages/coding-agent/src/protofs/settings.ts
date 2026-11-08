import { existsSync } from "node:fs";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

/** Test seam for the filesystem, executable and platform inputs of protofs resolution. */
export interface ProtofsCommandEnvironment {
	execPath?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	moduleDir?: string;
	exists?: (filePath: string) => boolean;
	which?: (command: string) => string | null;
}

/** `darwin-arm64`, `linux-x64`, … or undefined for an unsupported host. */
function platformTag(platform: NodeJS.Platform, arch: string): string | undefined {
	if (platform !== "darwin" && platform !== "linux") return undefined;
	if (arch !== "arm64" && arch !== "x64") return undefined;
	return `${platform}-${arch}`;
}

/**
 * Resolve the protofs command in this order: explicit `protofs.path`, a bundled
 * sibling of the running proto binary, the development build in this repository,
 * then `protofs` on PATH. Returns undefined when `protofs.enabled` is off or no
 * candidate exists.
 */
export function resolveProtofsCommand(
	settings: Settings,
	environment: ProtofsCommandEnvironment = {},
): string | undefined {
	if (!settings.get("protofs.enabled")) return undefined;
	const explicit = settings.get("protofs.path")?.trim();
	if (explicit) return explicit;

	const execPath = environment.execPath ?? process.execPath;
	const platform = environment.platform ?? process.platform;
	const arch = environment.arch ?? process.arch;
	const moduleDir = environment.moduleDir ?? import.meta.dir;
	const exists = environment.exists ?? existsSync;
	const which = environment.which ?? $which;
	const execDir = path.dirname(execPath);
	const tag = platformTag(platform, arch);

	const candidates: string[] = [];
	if (tag) {
		candidates.push(path.join(execDir, `protofs-${tag}`));
	}
	candidates.push(path.join(execDir, "protofs"));
	if (tag) {
		candidates.push(path.join(moduleDir, "..", "..", "binaries", `protofs-${tag}`));
	}
	candidates.push(path.join(moduleDir, "..", "..", "..", "protofs", "protofs"));

	for (const candidate of candidates) {
		if (exists(candidate)) return candidate;
	}
	return which("protofs") ? "protofs" : undefined;
}

/**
 * The protofs command agents and isolated subagents use, or `undefined` when
 * `protofs.enabled` is off or no bundled, development or PATH binary exists.
 * Read by the system prompt (checkout guidance) and the task runner
 * (protofs-backed isolation when `orchestrator.isolation.mode` is `auto`).
 */
export function protofsCommand(settings: Settings): string | undefined {
	return resolveProtofsCommand(settings);
}
