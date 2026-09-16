/**
 * Target paths for TTSR conditions.
 *
 * A tool call names its files in whatever spelling the model typed —
 * `src/a.ts`, `./src/a.ts`, `/home/me/proj/src/a.ts`. Rules are written against
 * one of those spellings and must not care which arrived, so every raw path is
 * resolved once, against the session cwd, into the three spellings a condition
 * can legitimately test. Containment tests (`under`, `outside`) use the absolute
 * form, which is the only one that can answer "did this write escape the
 * workspace?".
 */

import * as os from "node:os";
import * as path from "node:path";
import { expandTilde } from "../tools/path-utils";

/** Cwd-relative directory token accepted by `under:`/`outside:`. */
export const CWD_ROOT_TOKEN = "cwd";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export interface TargetPath {
	/** The path as the tool spelled it, slash-normalized. */
	raw: string;
	/** Absolute filesystem path; `undefined` for scheme URIs (`https://`, `local://`). */
	absolute?: string;
	/** Cwd-relative spelling; `undefined` when the path escapes the cwd. */
	relative?: string;
}

function slashes(value: string): string {
	return value.replaceAll("\\", "/");
}

/** Resolve the paths a tool call names into the spellings conditions may test. */
export function resolveTargetPaths(filePaths: readonly string[] | undefined, cwd?: string): TargetPath[] {
	if (!filePaths || filePaths.length === 0) return [];
	const base = cwd && cwd.length > 0 ? cwd : process.cwd();
	const targets: TargetPath[] = [];
	const seen = new Set<string>();
	for (const filePath of filePaths) {
		const raw = slashes(filePath.trim());
		if (raw.length === 0 || seen.has(raw)) continue;
		seen.add(raw);
		if (SCHEME.test(raw)) {
			targets.push({ raw });
			continue;
		}
		const absolute = slashes(path.resolve(base, expandTilde(raw)));
		const relative = slashes(path.relative(base, absolute));
		const inside =
			relative.length > 0 && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative);
		targets.push({ raw, absolute, relative: inside ? relative : undefined });
	}
	return targets;
}

/**
 * Resolve a `under:`/`outside:` directory. `cwd` is the reserved token for the
 * session directory; everything else is a literal path, tilde-expanded and
 * resolved against the session cwd.
 */
export function resolveRootDir(root: string, cwd: string): string {
	const trimmed = root.trim();
	if (trimmed === CWD_ROOT_TOKEN) return slashes(path.resolve(cwd));
	if (trimmed === "~") return slashes(os.homedir());
	return slashes(path.resolve(cwd, expandTilde(slashes(trimmed))));
}

/** Whether an absolute path is the root directory itself or sits beneath it. */
export function isUnderRoot(absolute: string, root: string): boolean {
	if (absolute === root) return true;
	const prefix = root.endsWith("/") ? root : `${root}/`;
	return absolute.startsWith(prefix);
}

/** Match a glob against one target, accepting any spelling plus a bare basename. */
export function matchesTarget(glob: Bun.Glob, target: TargetPath): boolean {
	if (glob.match(target.raw)) return true;
	if (target.relative && glob.match(target.relative)) return true;
	if (target.absolute && glob.match(target.absolute)) return true;
	const slashIndex = target.raw.lastIndexOf("/");
	if (slashIndex === -1) return false;
	return glob.match(target.raw.slice(slashIndex + 1));
}

/** Match a glob against a resolved target list. */
export function matchesPathGlob(glob: Bun.Glob, targets: readonly TargetPath[] | undefined): boolean {
	if (!targets || targets.length === 0) return false;
	return targets.some(target => matchesTarget(glob, target));
}
