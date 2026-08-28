#!/usr/bin/env bun
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const WRITE = process.argv.includes("--write");

const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])((?:\.\.?\/)[^"']*)\2/g;

const MODULE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

const pkgCache = new Map<string, { root: string; name: string } | null>();
function findPackage(startDir: string): { root: string; name: string } | null {
	let dir = startDir;
	const visited: string[] = [];
	while (dir.startsWith(ROOT) && dir.length >= ROOT.length) {
		if (pkgCache.has(dir)) {
			const cached = pkgCache.get(dir)!;
			for (const v of visited) pkgCache.set(v, cached);
			return cached;
		}
		visited.push(dir);
		const pj = join(dir, "package.json");
		if (existsSync(pj)) {
			let result: { root: string; name: string } | null = null;
			try {
				const name = JSON.parse(readFileSync(pj, "utf8")).name;
				if (typeof name === "string" && name) result = { root: dir, name };
			} catch {}
			if (result) {
				for (const v of visited) pkgCache.set(v, result);
				return result;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const v of visited) pkgCache.set(v, null);
	return null;
}

const isFile = (p: string): boolean => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

function resolveTarget(fromFile: string, spec: string): string | null {
	const abs = resolve(dirname(fromFile), spec);
	const candidates: string[] = [abs];
	const jsExt = abs.match(/\.(js|jsx|mjs|cjs)$/i);
	if (jsExt) {
		const stem = abs.slice(0, -jsExt[0].length);
		candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
	}
	for (const e of MODULE_EXTS) candidates.push(`${abs}${e}`);
	for (const e of MODULE_EXTS) candidates.push(join(abs, `index${e}`));
	for (const c of candidates) if (isFile(c)) return c;
	return null;
}

interface Change {
	from: string;
	to: string;
}

function rewriteFile(file: string): { content: string; changes: Change[]; skipped: string[] } {
	const src = readFileSync(file, "utf8");
	const changes: Change[] = [];
	const skipped: string[] = [];

	const content = src.replace(SPEC_RE, (full, lead, quote, spec) => {
		const target = resolveTarget(file, spec);
		if (!target) return full;
		const pkg = findPackage(target);
		if (!pkg) return full;

		const srcDir = join(pkg.root, "src");
		if (!target.startsWith(srcDir + sep)) return full;

		const realExt = extname(target).toLowerCase();
		if (!MODULE_EXTS.includes(realExt)) {
			skipped.push(spec);
			return full;
		}

		let sub = relative(srcDir, target).split(sep).join("/").slice(0, -realExt.length);
		sub = sub.replace(/\/index$/i, "");
		if (sub === "index") sub = "";

		const newSpec = sub ? `${pkg.name}/${sub}` : pkg.name;
		if (newSpec === spec) return full;
		changes.push({ from: spec, to: newSpec });
		return `${lead}${quote}${newSpec}${quote}`;
	});

	return { content, changes, skipped };
}

const files = new Set<string>();
for (const pattern of ["packages/*/test/**/*.{ts,tsx}", "packages/*/tests/**/*.{ts,tsx}"]) {
	for (const f of new Glob(pattern).scanSync({ cwd: ROOT, absolute: true })) files.add(f);
}

let totalChanges = 0;
let changedFiles = 0;
const skippedAssets: string[] = [];

for (const file of [...files].sort()) {
	const { content, changes, skipped } = rewriteFile(file);
	if (skipped.length) skippedAssets.push(...skipped.map(s => `${relative(ROOT, file)}: ${s}`));
	if (!changes.length) continue;
	changedFiles++;
	totalChanges += changes.length;
	const rel = relative(ROOT, file);
	console.log(`\n${rel}`);
	for (const c of changes) console.log(`  ${c.from}  ->  ${c.to}`);
	if (WRITE) writeFileSync(file, content);
}

console.log(`\n${WRITE ? "Applied" : "Would apply"} ${totalChanges} rewrite(s) across ${changedFiles} file(s).`);
if (skippedAssets.length) {
	console.log(`\nSkipped ${skippedAssets.length} asset import(s) into src (no public subpath):`);
	for (const s of skippedAssets) console.log(`  ${s}`);
}
if (!WRITE && totalChanges) console.log(`\nRe-run with --write to apply.`);
