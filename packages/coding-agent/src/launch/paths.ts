import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";

export { getDaemonRuntimeDir as daemonRuntimeDir };

const SCOPE_FILE = "scope.json";

export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

export async function writeDaemonScopeMeta(runtimeDir: string, projectDir: string): Promise<void> {
	await Bun.write(path.join(runtimeDir, SCOPE_FILE), JSON.stringify({ projectDir }));
}

export async function readDaemonScopeMeta(runtimeDir: string): Promise<string | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, SCOPE_FILE)).json();
		if (typeof raw === "object" && raw !== null && "projectDir" in raw && typeof raw.projectDir === "string") {
			return raw.projectDir;
		}
	} catch {}
	return undefined;
}

export function daemonBrokerEndpoint(_projectDir: string, runtimeDir: string): string {
	return path.join(runtimeDir, "broker.sock");
}
