#!/usr/bin/env bun

import * as path from "node:path";
import { $ } from "bun";
import { $which } from "../packages/utils/src/which";

const repoRoot = path.join(import.meta.dir, "..");

export const BUN2NIX_NPM_SPEC = "bun2nix@2.1.2";

export function normalizeLockfileVersion(contents: string): string {
	const stamp = /^(\s*"lockfileVersion":\s*)(\d+)(,)/m.exec(contents);
	if (!stamp) throw new Error("bun.lock is missing a lockfileVersion stamp");
	const version = Number(stamp[2]);
	if (version <= 1) return contents;
	if (version > 2) {
		throw new Error(
			`bun.lock is lockfileVersion ${version}, which changes content (scoped overrides) and cannot be downgraded for bun2nix`,
		);
	}
	return `${contents.slice(0, stamp.index)}${stamp[1]}1${stamp[3]}${contents.slice(stamp.index + stamp[0].length)}`;
}

async function normalizeBunLock(): Promise<void> {
	const lockPath = path.join(repoRoot, "bun.lock");
	const contents = await Bun.file(lockPath).text();
	const normalized = normalizeLockfileVersion(contents);
	if (normalized !== contents) await Bun.write(lockPath, normalized);
}

type FindExecutable = (command: string) => string | null;

export type NixBunDepsGenerator =
	| { kind: "bun2nix"; executable: string }
	| { kind: "nix"; executable: string }
	| { kind: "bunx"; package: typeof BUN2NIX_NPM_SPEC };

export function resolveNixBunDepsGenerator(findExecutable: FindExecutable = $which): NixBunDepsGenerator {
	const bun2nix = findExecutable("bun2nix");
	if (bun2nix) return { kind: "bun2nix", executable: bun2nix };

	const nix = findExecutable("nix");
	if (nix) return { kind: "nix", executable: nix };

	return { kind: "bunx", package: BUN2NIX_NPM_SPEC };
}

export async function generateNixBunDeps(generator: NixBunDepsGenerator = resolveNixBunDepsGenerator()): Promise<void> {
	await normalizeBunLock();
	if (generator.kind === "bun2nix") {
		await $`${generator.executable} -l bun.lock -c ../ -o nix/bun.nix`.cwd(repoRoot);
		return;
	}
	if (generator.kind === "nix") {
		await $`${generator.executable} --extra-experimental-features ${"nix-command flakes"} --accept-flake-config develop --command bun2nix -l bun.lock -c ../ -o nix/bun.nix`.cwd(
			repoRoot,
		);
		return;
	}

	await $`bunx ${generator.package} -l bun.lock -c ../ -o nix/bun.nix`.cwd(repoRoot);
}

if (import.meta.main) await generateNixBunDeps();
