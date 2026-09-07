#!/usr/bin/env bun

import { $ } from "bun";

const REPO = process.env.PROTO_REPO ?? "myanvoos/proto";
const HOMEPAGE = "https://github.com/myanvoos/proto";
const DESC = "Coding agent with the IDE wired in";

interface ReleaseAsset {
	name: string;
	digest?: string;
}

function parseArgs(argv: readonly string[]): { tag: string; out: string | null } {
	const rest = [...argv];
	let out: string | null = null;
	const outIdx = rest.indexOf("--out");
	if (outIdx >= 0) {
		out = rest[outIdx + 1] ?? null;
		if (!out) throw new Error("--out requires a path");
		rest.splice(outIdx, 2);
	}
	const tag = rest.find(a => !a.startsWith("--"));
	if (!tag) throw new Error("usage: ci-update-brew-formula.ts <tag> [--out <file>]");
	return { tag, out };
}

async function fetchAssets(tag: string): Promise<ReleaseAsset[]> {
	const res = await $`gh release view ${tag} --repo ${REPO} --json assets`.quiet().nothrow();
	if (res.exitCode !== 0) {
		throw new Error(`gh release view ${tag} failed: ${res.stderr.toString().trim()}`);
	}
	const parsed = JSON.parse(res.stdout.toString()) as { assets: ReleaseAsset[] };
	return parsed.assets;
}

function sha256For(assets: readonly ReleaseAsset[], name: string): string {
	const asset = assets.find(a => a.name === name);
	if (!asset) throw new Error(`release is missing asset ${name}`);
	if (!asset.digest?.startsWith("sha256:")) {
		throw new Error(`asset ${name} has no sha256 digest (got ${asset.digest ?? "none"})`);
	}
	return asset.digest.slice("sha256:".length);
}

export function renderFormula(version: string, sums: Record<string, string>): string {
	return `class Proto < Formula
  desc "${DESC}"
  homepage "${HOMEPAGE}"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/${REPO}/releases/download/v#{version}/proto-darwin-arm64",
          using: :nounzip
      sha256 "${sums["proto-darwin-arm64"]}"
    end
    on_intel do
      url "https://github.com/${REPO}/releases/download/v#{version}/proto-darwin-x64",
          using: :nounzip
      sha256 "${sums["proto-darwin-x64"]}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/${REPO}/releases/download/v#{version}/proto-linux-arm64",
          using: :nounzip
      sha256 "${sums["proto-linux-arm64"]}"
    end
    on_intel do
      url "https://github.com/${REPO}/releases/download/v#{version}/proto-linux-x64",
          using: :nounzip
      sha256 "${sums["proto-linux-x64"]}"
    end
  end

  def install
    bin.install Dir["proto-*"].first => "proto"
    (bin/"proto").chmod 0555
    with_env(HOME: buildpath) do
      generate_completions_from_executable(bin/"proto", "completions", shells: [:bash, :zsh, :fish])
    end
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/proto --version")
  end
end
`;
}

async function main(): Promise<void> {
	const { tag, out } = parseArgs(process.argv.slice(2));
	const version = tag.replace(/^v/, "");
	const assets = await fetchAssets(tag);

	const targets = ["proto-darwin-arm64", "proto-darwin-x64", "proto-linux-arm64", "proto-linux-x64"];
	const sums: Record<string, string> = {};
	for (const name of targets) sums[name] = sha256For(assets, name);

	const formula = renderFormula(version, sums);
	if (out) {
		await Bun.write(out, formula);
		console.log(`wrote ${out} for ${tag}`);
	} else {
		process.stdout.write(formula);
	}
}

if (import.meta.main) {
	await main();
}
