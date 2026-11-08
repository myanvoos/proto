/**
 * In-process protofs: proto loads the vendored `libprotofs` shared library and
 * runs the daemon inside its own process. The admin socket protocol is
 * unchanged, so `callSocket` and the checkout code work as before.
 *
 * The library is built by `bun run build:protofs` and shipped beside the proto
 * binary. When it is missing (source installs, unsupported platforms), callers
 * fall back to the bundled `protofs` executable.
 */
import { CString, dlopen, type FFIFunction, FFIType, type Library, type Pointer } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Daemon } from "./daemon";

/** Symbols exported by `libprotofs`. */
const PROTOFS_SYMBOLS = {
	ProtofsStart: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.ptr },
	ProtofsStop: { args: [], returns: FFIType.void },
	ProtofsFree: { args: [FFIType.ptr], returns: FFIType.void },
	ProtofsVersion: { args: [], returns: FFIType.ptr },
} as const satisfies Record<string, FFIFunction>;

type ProtofsLibrary = Library<typeof PROTOFS_SYMBOLS>;

const libraries = new Map<string, ProtofsLibrary | undefined>();
let started: ProtofsLibrary | undefined;
let exitHookInstalled = false;

/** The target id the release build uses (`darwin-arm64`, `linux-x64`, …). */
function targetId(): string {
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `${process.platform}-${arch}`;
}

/** Shared-library extension for the host platform. */
function libraryExtension(): string {
	if (process.platform === "darwin") return "dylib";
	if (process.platform === "win32") return "dll";
	return "so";
}

/**
 * Candidate library paths, in order: an explicit setting/env override, the
 * sibling of the running binary, the development build, then the source build.
 */
function libraryCandidates(explicit?: string): string[] {
	const target = targetId();
	const ext = libraryExtension();
	const names = [`libprotofs-${target}.${ext}`, `libprotofs.${ext}`];
	const candidates: string[] = [];
	if (explicit) candidates.push(explicit);
	if (Bun.env.PROTOFS_LIBRARY) candidates.push(Bun.env.PROTOFS_LIBRARY);
	for (const name of names) candidates.push(path.join(path.dirname(process.execPath), name));
	for (const name of names) candidates.push(path.join(import.meta.dir, "../../binaries", name));
	for (const name of names) candidates.push(path.join(import.meta.dir, "../../../../protofs/build", name));
	return candidates;
}

/** Load the library once per path; undefined when no candidate exists or loads. */
function loadLibrary(explicit?: string): ProtofsLibrary | undefined {
	const key = explicit ?? "";
	if (libraries.has(key)) return libraries.get(key);
	let loaded: ProtofsLibrary | undefined;
	for (const candidate of libraryCandidates(explicit)) {
		if (!fs.existsSync(candidate)) continue;
		try {
			loaded = dlopen(candidate, PROTOFS_SYMBOLS);
			break;
		} catch {
			// A wrong-arch or broken library is not fatal: try the next path.
		}
	}
	libraries.set(key, loaded);
	return loaded;
}

/** True when the shared library is present and loadable. */
export function hasEmbeddedProtofs(explicit?: string): boolean {
	return loadLibrary(explicit) !== undefined;
}

/** Read a C string returned by the library and release it. */
function takeString(library: ProtofsLibrary, pointer: Pointer | bigint | null): string {
	if (!pointer) return "";
	try {
		return new CString(pointer).toString();
	} finally {
		library.symbols.ProtofsFree(pointer);
	}
}

/** The library's version, or undefined when it is unavailable. */
export function embeddedProtofsVersion(explicit?: string): string | undefined {
	const library = loadLibrary(explicit);
	if (!library) return undefined;
	return takeString(library, library.symbols.ProtofsVersion());
}

/** Options for {@link startEmbeddedDaemon}. */
export interface EmbeddedProtofsOptions {
	/** Explicit `libprotofs` path; unset uses the bundled/development candidates. */
	library?: string;
	/** State directory; unset uses `PROTOFS_STATE`, the config, then the platform default. */
	state?: string;
	/** Checkout mount; unset uses `PROTOFS_MOUNT`, the config, then the platform default. */
	mount?: string;
}

/**
 * Start the daemon in-process (or attach to one already running for the same
 * state) and return its socket. `undefined` when the library is unavailable.
 */
export async function startEmbeddedDaemon(options: string | EmbeddedProtofsOptions = {}): Promise<Daemon | undefined> {
	const explicit = typeof options === "string" ? options : options.library;
	const state =
		typeof options === "string" ? (Bun.env.PROTOFS_STATE ?? "") : (options.state ?? Bun.env.PROTOFS_STATE ?? "");
	const mount =
		typeof options === "string" ? (Bun.env.PROTOFS_MOUNT ?? "") : (options.mount ?? Bun.env.PROTOFS_MOUNT ?? "");
	const library = loadLibrary(explicit);
	if (!library) return undefined;
	const raw = takeString(library, library.symbols.ProtofsStart(state, mount));
	let reply: { socket?: unknown; mount?: unknown; error?: unknown };
	try {
		reply = JSON.parse(raw) as typeof reply;
	} catch {
		throw new Error(`protofs library returned an invalid start reply: ${raw}`);
	}
	if (typeof reply.error === "string" && reply.error) throw new Error(reply.error);
	if (typeof reply.socket !== "string" || typeof reply.mount !== "string") {
		throw new Error(`protofs library returned an incomplete start reply: ${raw}`);
	}
	started = library;
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", () => stopEmbeddedDaemon());
	}
	const dir = path.dirname(reply.mount);
	const parent = await fs.promises.realpath(dir).catch(() => dir);
	return { socket: reply.socket, mount: path.join(parent, path.basename(reply.mount)) };
}

/** Stop the daemon this process started; a daemon it attached to stays up. */
export function stopEmbeddedDaemon(): void {
	if (!started) return;
	try {
		started.symbols.ProtofsStop();
	} catch {
		// Process teardown must not fail on a daemon that already stopped.
	} finally {
		started = undefined;
	}
}
