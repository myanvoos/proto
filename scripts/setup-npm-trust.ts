#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { LEAF_TARGETS } from "../packages/natives/scripts/gen-npm-packages.ts";
import { compareVersions } from "../packages/utils/src/version.ts";
import { packages } from "./ci-release-publish.ts";

const repoRoot = path.join(import.meta.dir, "..");
const MIN_NPM = "11.16.0";
const DEFAULT_WORKFLOW = "ci.yml";
const FALLBACK_REPO = "can1357/proto";
const PLACEHOLDER_VERSION = "0.0.0";

interface NativeLeafTarget {
	tag: string;
	os: string;
	cpu: string;
}

interface PlaceholderManifest {
	name: string;
	version: string;
	description: string;
	license: string;
	os: string[];
	cpu: string[];
	repository: {
		type: string;
		url: string;
		directory: string;
	};
	engines: {
		bun: string;
	};
	publishConfig: {
		access: string;
	};
}

interface Options {
	list: boolean;
	dryRun: boolean;
	force: boolean;
	repo?: string;
	workflow: string;
	only?: Set<string>;
}

function parseArgs(argv: readonly string[]): Options {
	const opts: Options = { list: false, dryRun: false, force: false, workflow: DEFAULT_WORKFLOW };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-h":
			case "--help":
				printUsageAndExit();
				break;
			case "--list":
				opts.list = true;
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--force":
				opts.force = true;
				break;
			case "--repo":
				opts.repo = argv[++i];
				break;
			case "--workflow":
			case "--file":
				opts.workflow = argv[++i];
				break;
			case "--only":
				opts.only = new Set(
					(argv[++i] ?? "")
						.split(",")
						.map(s => s.trim())
						.filter(Boolean),
				);
				break;
			default:
				console.error(`Unknown argument: ${arg}`);
				printUsageAndExit(1);
		}
	}
	return opts;
}

function printUsageAndExit(code = 0): never {
	console.log(
		[
			"Usage: bun scripts/setup-npm-trust.ts [options]",
			"",
			"  --list            Show current trusted-publisher config, change nothing",
			"  --dry-run         Print the npm trust commands, change nothing",
			"  --force           Replace an existing config (revoke + recreate)",
			"  --only a,b,c      Limit to the named packages",
			"  --repo owner/repo Override the GitHub repo (default: from package.json)",
			"  --workflow file   Override the workflow filename (default: ci.yml)",
			"  -h, --help        Show this help",
		].join("\n"),
	);
	process.exit(code);
}

function parseRepo(repository: { url?: string } | string | undefined): string | null {
	const url = typeof repository === "string" ? repository : repository?.url;
	if (!url) return null;
	const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
	return match ? `${match[1]}/${match[2]}` : null;
}

interface ManifestShape {
	name?: string;
	private?: boolean;
	repository?: { url?: string } | string;
}

async function collectTargets(): Promise<{ names: string[]; repoFromManifest: string | null }> {
	const seen = new Set<string>();
	const names: string[] = [];
	let repoFromManifest: string | null = null;
	for (const pkg of packages) {
		const manifest = (await Bun.file(path.join(repoRoot, pkg.dir, "package.json")).json()) as ManifestShape;
		if (manifest.private) continue;
		repoFromManifest ??= parseRepo(manifest.repository);
		if (typeof manifest.name === "string" && !seen.has(manifest.name)) {
			seen.add(manifest.name);
			names.push(manifest.name);
		}

		if (pkg.kind === "native") {
			for (const target of LEAF_TARGETS) {
				const leaf = `@oh-my-pi/pi-natives-${target.tag}`;
				if (!seen.has(leaf)) {
					seen.add(leaf);
					names.push(leaf);
				}
			}
		}
	}
	return { names, repoFromManifest };
}

function npmInteractive(args: readonly string[]): Promise<number> {
	return Bun.spawn(["npm", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
}

async function trustListJson(name: string): Promise<{ ok: boolean; hasConfig: boolean; ids: string[] }> {
	const proc = Bun.spawn(["npm", "trust", "list", name, "--json"], {
		stdin: "inherit",
		stdout: "pipe",
		stderr: "inherit",
	});
	const stdout = (await new Response(proc.stdout).text()).trim();
	const code = await proc.exited;
	return { ok: code === 0, hasConfig: code === 0 && stdout.length > 0, ids: extractIds(stdout) };
}

function extractIds(jsonish: string): string[] {
	if (!jsonish) return [];
	const ids: string[] = [];
	try {
		const parsed = JSON.parse(jsonish) as unknown;
		const items = Array.isArray(parsed) ? parsed : [parsed];
		for (const item of items) {
			const id = (item as { id?: unknown }).id;
			if (typeof id === "string") ids.push(id);
		}
		if (ids.length > 0) return ids;
	} catch {}
	for (const match of jsonish.matchAll(/"id"\s*:\s*"([^"]+)"/g)) ids.push(match[1]);
	return ids;
}

async function packageExists(name: string): Promise<boolean> {
	const result = await $`npm view ${name} version`.nothrow().quiet();
	return result.exitCode === 0;
}

async function waitForPackageExists(name: string): Promise<boolean> {
	for (let attempt = 0; attempt < 6; attempt++) {
		if (await packageExists(name)) return true;
		await Bun.sleep(1000 * (attempt + 1));
	}
	return false;
}

function nativeLeafName(tag: string): string {
	return `@oh-my-pi/pi-natives-${tag}`;
}

function nativeLeafTargetForPackage(name: string): NativeLeafTarget | null {
	for (const target of LEAF_TARGETS) {
		if (nativeLeafName(target.tag) === name) return target;
	}
	return null;
}

function repoGitUrl(repo: string): string {
	return `git+https://github.com/${repo}.git`;
}

function placeholderManifest(name: string, target: NativeLeafTarget, repo: string): PlaceholderManifest {
	return {
		name,
		version: PLACEHOLDER_VERSION,
		description: `Placeholder for the ${target.tag} native addon of @oh-my-pi/pi-natives. The real binary is published during release.`,
		license: "MIT",
		os: [target.os],
		cpu: [target.cpu],
		repository: {
			type: "git",
			url: repoGitUrl(repo),
			directory: "packages/natives",
		},
		engines: {
			bun: ">=1.3.14",
		},
		publishConfig: {
			access: "public",
		},
	};
}

function placeholderReadme(name: string, target: NativeLeafTarget): string {
	return [
		`# ${name}`,
		"",
		`Placeholder package reserving the npm name for the \`${target.tag}\` native addon of \`@oh-my-pi/pi-natives\`.`,
		"",
		`This \`${PLACEHOLDER_VERSION}\` release ships no binary. The real, versioned platform addon is generated during release and installed as an optional dependency of the core package.`,
		"",
	].join("\n");
}

async function publishNativeLeafPlaceholder(name: string, target: NativeLeafTarget, repo: string): Promise<boolean> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proto-native-placeholder-"));
	try {
		await Bun.write(
			path.join(tmpDir, "package.json"),
			`${JSON.stringify(placeholderManifest(name, target, repo), null, "\t")}\n`,
		);
		await Bun.write(path.join(tmpDir, "README.md"), placeholderReadme(name, target));
		return (await npmInteractive(["publish", tmpDir, "--access", "public"])) === 0;
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

function shouldThrottle(first: boolean): boolean {
	return !first;
}

type Outcome = "configured" | "already" | "replaced" | "missing" | "failed";

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));

	const npmVersion = (await $`npm --version`.nothrow().quiet()).stdout.toString().trim();
	if (!npmVersion) {
		console.error("Could not determine npm version. Is npm installed and on PATH?");
		process.exit(1);
	}
	if (compareVersions(npmVersion, MIN_NPM) < 0) {
		console.error(`npm ${MIN_NPM}+ is required for trusted publishing (found ${npmVersion}).`);
		console.error("Upgrade with: npm install -g npm@latest");
		process.exit(1);
	}

	const { names, repoFromManifest } = await collectTargets();
	let targets = names;
	if (opts.only) {
		const only = opts.only;
		const unmatched = [...only].filter(n => !names.includes(n));
		if (unmatched.length > 0) console.warn(`--only names not in the publish set: ${unmatched.join(", ")}`);
		targets = names.filter(n => only.has(n));
	}
	if (targets.length === 0) {
		console.error("No packages to process.");
		process.exit(1);
	}

	const repo = opts.repo ?? repoFromManifest ?? FALLBACK_REPO;
	const workflow = opts.workflow;

	if (!(await Bun.file(path.join(repoRoot, ".github", "workflows", workflow)).exists())) {
		console.warn(
			`Warning: .github/workflows/${workflow} not found; npm will still accept it, but OIDC won't match a non-existent workflow.`,
		);
	}

	if (opts.dryRun) {
		console.log(`Would configure trust for ${targets.length} package(s) → repo ${repo}, workflow ${workflow}:\n`);
		for (const name of targets) {
			const target = nativeLeafTargetForPackage(name);
			if (target) console.log(`  if missing: npm publish ${name}@${PLACEHOLDER_VERSION} placeholder`);
			console.log(`  npm trust github ${name} --repo ${repo} --file ${workflow} --allow-publish --yes`);
		}
		return;
	}

	const whoami = await $`npm whoami`.nothrow().quiet();
	if (whoami.exitCode !== 0) {
		console.error("Not logged in to npm. Run `npm login` (with a 2FA-enabled account) first.");
		process.exit(1);
	}
	console.log(`Logged in as ${whoami.stdout.toString().trim()} → repo ${repo}, workflow ${workflow}\n`);

	if (opts.list) {
		for (const name of targets) {
			if (!(await packageExists(name))) {
				console.log(`- ${name}: not published yet`);
				continue;
			}
			console.log(`# ${name}`);
			await npmInteractive(["trust", "list", name]);
		}
		return;
	}

	console.log("The first mutating npm operation triggers 2FA. When prompted, complete it and choose");
	console.log(
		"'skip 2FA for the next 5 minutes' on the npm site so placeholder publishes and trust setup run unattended.\n",
	);

	const outcomes = new Map<string, Outcome>();
	let bootstrapped = 0;
	let first = true;
	for (const name of targets) {
		if (!(await packageExists(name))) {
			const target = nativeLeafTargetForPackage(name);
			if (!target) {
				outcomes.set(name, "missing");
				console.log(`- ${name}: not published yet — create it first, then re-run.`);
				continue;
			}
			if (shouldThrottle(first)) await Bun.sleep(2000);
			first = false;
			console.log(`- ${name}: not published yet — publishing inert ${PLACEHOLDER_VERSION} placeholder.`);
			if (!(await publishNativeLeafPlaceholder(name, target, repo))) {
				outcomes.set(name, "failed");
				console.error(`- ${name}: failed to publish placeholder.`);
				continue;
			}
			if (!(await waitForPackageExists(name))) {
				outcomes.set(name, "failed");
				console.error(`- ${name}: placeholder published, but npm view did not observe it yet.`);
				continue;
			}
			bootstrapped++;
		}

		if (shouldThrottle(first)) await Bun.sleep(2000);
		first = false;

		const existing = await trustListJson(name);
		if (existing.hasConfig && !opts.force) {
			outcomes.set(name, "already");
			console.log(`- ${name}: already configured (use --force to replace).`);
			continue;
		}

		let replaced = false;
		if (existing.hasConfig && opts.force) {
			let revokedAll = true;
			for (const id of existing.ids) {
				if ((await npmInteractive(["trust", "revoke", name, "--id", id])) !== 0) {
					revokedAll = false;
					break;
				}
			}
			if (!revokedAll) {
				outcomes.set(name, "failed");
				console.error(`- ${name}: failed to revoke existing config.`);
				continue;
			}
			replaced = true;
		}

		const code = await npmInteractive([
			"trust",
			"github",
			name,
			"--repo",
			repo,
			"--file",
			workflow,
			"--allow-publish",
			"--yes",
		]);
		outcomes.set(name, code === 0 ? (replaced ? "replaced" : "configured") : "failed");
	}

	printSummary(outcomes, bootstrapped);
	const failed = [...outcomes.values()].filter(o => o === "failed").length;
	process.exit(failed > 0 ? 1 : 0);
}

function printSummary(outcomes: ReadonlyMap<string, Outcome>, bootstrapped: number): void {
	const counts: Record<Outcome, number> = { configured: 0, already: 0, replaced: 0, missing: 0, failed: 0 };
	for (const outcome of outcomes.values()) counts[outcome]++;
	console.log("\nSummary:");
	if (bootstrapped) console.log(`  bootstrapped: ${bootstrapped} placeholder package(s)`);
	console.log(`  configured:   ${counts.configured}`);
	if (counts.replaced) console.log(`  replaced:     ${counts.replaced}`);
	console.log(`  already:      ${counts.already}`);
	if (counts.missing) console.log(`  missing:      ${counts.missing} (not auto-bootstrappable)`);
	if (counts.failed) console.log(`  failed:       ${counts.failed}`);
}

await main();
