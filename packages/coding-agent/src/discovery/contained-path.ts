import * as fs from "node:fs";
import * as path from "node:path";

function isContained(base: string, target: string): boolean {
	const relative = path.relative(base, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function realpathIfExists(p: string): Promise<string | null> {
	try {
		return await fs.promises.realpath(p);
	} catch {
		return null;
	}
}

type ContainedPathResolution = { status: "missing" } | { status: "outside" } | { status: "ok"; realPath: string };

export async function resolveContainedPath(realBase: string, target: string): Promise<ContainedPathResolution> {
	if (!isContained(realBase, target)) return { status: "outside" };
	const real = await realpathIfExists(target);
	if (real === null) return { status: "missing" };
	return isContained(realBase, real) ? { status: "ok", realPath: real } : { status: "outside" };
}

export async function isContainedResolved(realBase: string, target: string): Promise<boolean> {
	if (!isContained(realBase, target)) return false;
	const real = await realpathIfExists(target);
	return real === null || isContained(realBase, real);
}

export function resolveContainedPathSync(realBase: string, target: string): ContainedPathResolution {
	if (!isContained(realBase, target)) return { status: "outside" };
	let real: string | null;
	try {
		real = fs.realpathSync(target);
	} catch {
		real = null;
	}
	if (real === null) return { status: "missing" };
	return isContained(realBase, real) ? { status: "ok", realPath: real } : { status: "outside" };
}
