#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";

export interface ProtofsTarget {
	id: string;
	goos: "darwin" | "linux";
	goarch: "amd64" | "arm64";
}

export const PROTOFS_TARGETS: readonly ProtofsTarget[] = [
	{ id: "darwin-arm64", goos: "darwin", goarch: "arm64" },
	{ id: "darwin-x64", goos: "darwin", goarch: "amd64" },
	{ id: "linux-x64", goos: "linux", goarch: "amd64" },
	{ id: "linux-arm64", goos: "linux", goarch: "arm64" },
	{ id: "linux-musl-x64", goos: "linux", goarch: "amd64" },
	{ id: "linux-musl-arm64", goos: "linux", goarch: "arm64" },
];

const repoRoot = path.join(import.meta.dir, "..");

export function hostProtofsTarget(): string {
	const arch = process.arch === "x64" ? "x64" : process.arch;
	if (process.platform === "darwin" && (arch === "arm64" || arch === "x64")) return `darwin-${arch}`;
	if (process.platform === "linux" && (arch === "arm64" || arch === "x64")) return `linux-${arch}`;
	throw new Error(
		`Unsupported host for protofs: ${process.platform}/${process.arch}. Pass --target with one of: ${PROTOFS_TARGETS.map(t => t.id).join(", ")}`,
	);
}

export function protofsTarget(id: string): ProtofsTarget {
	const target = PROTOFS_TARGETS.find(candidate => candidate.id === id);
	if (!target) {
		throw new Error(`Unknown protofs target "${id}". Expected one of: ${PROTOFS_TARGETS.map(t => t.id).join(", ")}`);
	}
	return target;
}

export function defaultProtofsOutput(target: string): string {
	return path.join(repoRoot, "packages", "coding-agent", "binaries", `protofs-${target}`);
}

export interface BuildProtofsOptions {
	target?: string;
	out?: string;
	dryRun?: boolean;
	root?: string;
}

/** Build one protofs target from the vendored Go module. Returns the output path. */
export async function buildProtofs(options: BuildProtofsOptions = {}): Promise<string> {
	const root = options.root ?? repoRoot;
	const target = protofsTarget(options.target ?? hostProtofsTarget());
	const out = path.resolve(
		root,
		options.out ?? path.join("packages", "coding-agent", "binaries", `protofs-${target.id}`),
	);
	const args = ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "."];
	if (options.dryRun) {
		console.log(`DRY RUN GOOS=${target.goos} GOARCH=${target.goarch} CGO_ENABLED=0 go ${args.join(" ")}`);
		return out;
	}
	const go = $which("go");
	if (!go) {
		throw new Error(
			"go was not found on PATH; install Go 1.27.3+ (CI installs it, or run `brew install go`) and retry",
		);
	}
	await fs.mkdir(path.dirname(out), { recursive: true });
	console.log(`Building protofs ${target.id} -> ${out}`);
	const proc = Bun.spawn([go, ...args], {
		cwd: path.join(root, "protofs"),
		env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0" },
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`go build failed for protofs ${target.id} (exit ${exitCode})`);
	return out;
}

function usage(): string {
	return `usage: bun scripts/build-protofs.ts [--target <id>] [--out <file>] [--dry-run]\n\nTargets: ${PROTOFS_TARGETS.map(t => t.id).join(", ")}`;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let target: string | undefined;
	let out: string | undefined;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--target") {
			target = argv[++i];
			if (!target) throw new Error("--target requires a value");
		} else if (arg.startsWith("--target=")) {
			target = arg.slice("--target=".length);
		} else if (arg === "--out") {
			out = argv[++i];
			if (!out) throw new Error("--out requires a value");
		} else if (arg.startsWith("--out=")) {
			out = arg.slice("--out=".length);
		} else if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--help" || arg === "-h") {
			console.log(usage());
			return;
		} else {
			throw new Error(`Unknown argument "${arg}"\n\n${usage()}`);
		}
	}
	await buildProtofs({ target, out, dryRun });
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
