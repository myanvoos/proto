import * as fs from "node:fs";

function runCommand(command: string, args: string[]): string | null {
	try {
		const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf-8").trim();
	} catch {
		return null;
	}
}

export interface LocalHostAddon {
	readonly filename: string;
	readonly x64Variant: "modern" | "baseline" | null;
}

export function resolveLocalHostAddon(host: {
	readonly platform: string;
	readonly arch: string;
	readonly avx2: boolean;
}): LocalHostAddon {
	const x64Variant = host.arch === "x64" ? (host.avx2 ? "modern" : "baseline") : null;
	const variantSuffix = x64Variant ? `-${x64Variant}` : "";
	return {
		filename: `pi_natives.${host.platform}-${host.arch}${variantSuffix}.node`,
		x64Variant,
	};
}

export function detectHostAvx2Support(): boolean {
	if (process.arch !== "x64") return false;

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		const leaf7 = runCommand("sysctl", ["-n", "machdep.cpu.leaf7_features"]);
		if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
		const features = runCommand("sysctl", ["-n", "machdep.cpu.features"]);
		return Boolean(features && /\bAVX2\b/i.test(features));
	}

	return false;
}
