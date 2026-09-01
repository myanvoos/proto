#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const SPECIFIER_RE = /(\b(?:from|import|module)\b\s*(?:\(\s*)?)("|')(\.[^"']*)(\2)/g;

export type EmitExt = ".d.ts" | ".js";

async function resolveEmitSpecifier(fromDir: string, spec: string, ext: EmitExt): Promise<string | null> {
	if (/\.(js|json|mjs|cjs)$/.test(spec)) return null;
	if (/\.d\.ts$/.test(spec)) return `${spec.slice(0, -".d.ts".length)}.js`;

	const abs = path.join(fromDir, spec);

	if (await exists(`${abs}${ext}`)) return `${spec}.js`;

	if (await exists(path.join(abs, `index${ext}`))) return `${spec.replace(/\/$/, "")}/index.js`;

	return null;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function fixEmitFile(filePath: string, ext: EmitExt): Promise<number> {
	const source = await Bun.file(filePath).text();
	const fromDir = path.dirname(filePath);
	let changed = 0;

	const edits: Array<{ match: string; replacement: string }> = [];
	for (const m of source.matchAll(SPECIFIER_RE)) {
		const [full, prefix, quote, spec] = m;
		const resolved = await resolveEmitSpecifier(fromDir, spec, ext);
		if (resolved && resolved !== spec) {
			edits.push({ match: full, replacement: `${prefix}${quote}${resolved}${quote}` });
		}
	}
	if (edits.length === 0) return 0;

	let out = source;
	for (const { match, replacement } of edits) {
		out = out.replace(match, replacement);
		changed++;
	}
	await Bun.write(filePath, out);
	return changed;
}

export async function fixEmitExtensions(dir: string, ext: EmitExt): Promise<{ files: number; specifiers: number }> {
	let files = 0;
	let specifiers = 0;
	const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		const n = await fixEmitFile(filePath, ext);
		if (n > 0) {
			files++;
			specifiers += n;
		}
	}
	return { files, specifiers };
}

if (import.meta.main) {
	const target = process.argv[2];
	const ext = (process.argv[3] ?? ".d.ts") as EmitExt;
	if (!target || (ext !== ".d.ts" && ext !== ".js")) {
		console.error("usage: fix-emit-extensions.ts <emitted dir> [.d.ts|.js]");
		process.exit(1);
	}
	const { files, specifiers } = await fixEmitExtensions(target, ext);
	console.log(`fix-emit-extensions: rewrote ${specifiers} specifiers across ${files} files in ${target}`);
}
