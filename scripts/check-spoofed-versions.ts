#!/usr/bin/env bun

import * as path from "node:path";
import { USER_AGENT } from "@oh-my-pi/pi-utils";

const PROVIDER_FILE = path.join(import.meta.dir, "../packages/catalog/src/wire/gemini-headers.ts");

interface VersionCheck {
	name: string;

	sourcePattern: RegExp;

	repo: string;

	parseTag: (tag: string) => string | null;
}

async function fetchLatestGitHubRelease(
	repo: string,
	parseTag: (tag: string) => string | null,
): Promise<string | null> {
	try {
		const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string };
		return data.tag_name ? parseTag(data.tag_name) : null;
	} catch {
		return null;
	}
}

const SEMVER_RE = /(\d+\.\d+\.\d+)/;

const checks: VersionCheck[] = [
	{
		name: "Gemini CLI",
		sourcePattern: /PI_AI_GEMINI_CLI_VERSION\s*\|\|\s*"(\d+\.\d+\.\d+)"/,
		repo: "google-gemini/gemini-cli",
		parseTag: tag => SEMVER_RE.exec(tag)?.[1] ?? null,
	},
];

async function run() {
	const doUpdate = process.argv.includes("--update");
	let source = await Bun.file(PROVIDER_FILE).text();
	let anyDrift = false;
	let anyUpdate = false;
	let anyChecked = false;

	for (const check of checks) {
		const match = check.sourcePattern.exec(source);
		if (!match?.[1]) {
			console.error(`[WARN] Could not extract current ${check.name} version from source`);
			continue;
		}

		const current = match[1];
		const latest = await fetchLatestGitHubRelease(check.repo, check.parseTag);

		if (!latest) {
			console.error(`[FAIL] Could not fetch latest ${check.name} version from ${check.repo}`);
			continue;
		}

		anyChecked = true;

		if (current === latest) {
			console.log(`[OK]   ${check.name}: ${current} (up to date)`);
		} else {
			console.log(`[DRIFT] ${check.name}: ${current} -> ${latest}`);
			anyDrift = true;

			if (doUpdate) {
				source = source.replace(match[0], match[0].replace(current, latest));
				anyUpdate = true;
				console.log(`       Updated in source.`);
			}
		}
	}

	if (anyUpdate) {
		await Bun.write(PROVIDER_FILE, source);
		console.log(`\nWrote updates to ${path.relative(process.cwd(), PROVIDER_FILE)}`);
	}

	if (!anyChecked) {
		console.error("\nNo version checks succeeded. Cannot verify freshness.");
		process.exit(1);
	}

	if (anyDrift && !doUpdate) {
		console.log("\nRun with --update to apply version bumps.");
		process.exit(1);
	}
}

run();
