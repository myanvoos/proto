#!/usr/bin/env bun

import { $ } from "bun";

interface PrMeta {
	number: number;
	title: string;
	author: { login: string };
}

function fail(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

function parseArgs(argv: string[]) {
	let branch: string | undefined;
	let pr: number | undefined;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run" || arg === "-n") dryRun = true;
		else if (arg === "--pr") {
			const val = argv[++i];
			if (!val || !/^\d+$/.test(val)) fail("--pr requires a numeric PR number");
			pr = Number(val);
		} else if (arg === "--help" || arg === "-h") {
			console.log("usage: merge-pr.ts <branch> [--pr <number>] [--dry-run]");
			process.exit(0);
		} else if (arg.startsWith("-")) fail(`unknown flag: ${arg}`);
		else if (branch) fail(`unexpected argument: ${arg}`);
		else branch = arg;
	}
	if (!branch) fail("usage: merge-pr.ts <branch> [--pr <number>] [--dry-run]");
	return { branch, pr, dryRun };
}

function prNumberFromBranchName(branch: string): number | undefined {
	const m = branch.match(/(?:^|[/_-])pr[/_-]?(\d+)(?:$|[/_-])/i) ?? branch.match(/^(\d+)[/_-]/);
	return m ? Number(m[1]) : undefined;
}

async function ghPrView(selector: string): Promise<PrMeta | undefined> {
	const res = await $`gh pr view ${selector} --json number,title,author`.quiet().nothrow();
	if (res.exitCode !== 0) return undefined;
	try {
		return res.json() as PrMeta;
	} catch {
		return undefined;
	}
}

async function resolvePr(branch: string, explicit: number | undefined): Promise<PrMeta> {
	if (explicit !== undefined) {
		const meta = await ghPrView(String(explicit));
		if (!meta) fail(`gh could not find PR #${explicit}`);
		return meta;
	}

	const byBranch = await ghPrView(branch);
	if (byBranch) return byBranch;
	const inferred = prNumberFromBranchName(branch);
	if (inferred !== undefined) {
		const meta = await ghPrView(String(inferred));
		if (meta) return meta;
	}
	fail(`could not resolve a PR for branch '${branch}'; pass --pr <number>`);
}

const CONVENTIONAL_PREFIX = /^[a-z]+(\([^)]+\))?!?: (.+)$/;

export function isCompliantSubject(subject: string): boolean {
	const m = CONVENTIONAL_PREFIX.exec(subject);
	if (!m) return false;
	const desc = m[2];
	return subject.length <= 72 && !/^[A-Z]/.test(desc) && !desc.endsWith(".");
}

if (import.meta.main) {
	const { branch, pr, dryRun } = parseArgs(process.argv.slice(2));

	let mergeRef = branch;
	const refCheck = await $`git rev-parse --verify --quiet ${branch}`.quiet().nothrow();
	if (refCheck.exitCode !== 0) {
		const remoteCheck = await $`git rev-parse --verify --quiet origin/${branch}`.quiet().nothrow();
		if (remoteCheck.exitCode !== 0) fail(`'${branch}' is neither a local nor an origin/ ref`);
		mergeRef = `origin/${branch}`;
		console.warn(`note: '${branch}' is not local; merging '${mergeRef}'`);
	}

	const meta = await resolvePr(branch, pr);

	const log = await $`git log --reverse --format=%s HEAD..${mergeRef}`.quiet().nothrow();
	if (log.exitCode !== 0) fail(`git log HEAD..${mergeRef} failed`);
	const subjects = log
		.text()
		.split("\n")
		.map(s => s.trim())
		.filter(Boolean);
	if (subjects.length === 0) fail(`'${branch}' has no commits ahead of HEAD`);
	const subject = subjects.find(isCompliantSubject);
	if (!subject)
		fail(`no compliant commit subject in HEAD..${mergeRef}; the merge message cannot comply with the schema`);
	const message = `Merge PR #${meta.number}: ${subject} (@${meta.author.login})`;

	if (dryRun) {
		console.log(message);
		process.exit(0);
	}

	const merge = await $`git merge --no-ff -m ${message} ${mergeRef}`.nothrow();
	process.exit(merge.exitCode);
}
