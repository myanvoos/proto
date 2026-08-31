/**
 * AST-based comment stripper for TS/JS family files.
 * Dry-run by default; pass --apply to write.
 */
import { parse } from "@babel/parser";

const APPLY = process.argv.includes("--apply");

const EXCLUDE = [
	/\/vendor\//,
	/^packages\/utils\/src\/ar\/rar\//,
	/^packages\/tui\/src\/stdin-buffer\.ts$/,
	/^packages\/coding-agent\/src\/cli\/gallery-fixtures\//,
];

const KEEP =
	/@ts-(?:expect-error|ignore|nocheck|check)|biome-ignore|eslint-(?:disable|enable|env)|prettier-ignore|deno-lint-ignore|istanbul\s+ignore|v8\s+ignore|c8\s+ignore|sourceMappingURL=|sourceURL=|@license|@preserve|Copyright/;

function isKept(text: string, range: Comment): boolean {
	const body = text.slice(range.start, range.end);
	if (body.startsWith("/*!")) return true;
	if (/^\/\/\/\s*</.test(body)) return true;
	return KEEP.test(body);
}

type Comment = { type: string; start: number; end: number; value: string };

function parseAst(text: string, kind: string): { comments: Comment[] } {
	return parse(text, {
		sourceType: "unambiguous",
		allowReturnOutsideFunction: true,
		errorRecovery: true,
		plugins: kind === "ts" ? ["typescript", "jsx", "importAttributes"] : ["jsx", "importAttributes"],
	}) as unknown as { comments: Comment[] };
}

function collect(text: string, kind: string): Comment[] {
	return parseAst(text, kind).comments ?? [];
}

function stripPass(text: string, kind: string): string {
	const ranges = collect(text, kind).filter((r) => !isKept(text, r));
	if (ranges.length === 0) return text;
	const cuts: Array<[number, number]> = [];
	for (const r of ranges) {
		const lineStart = text.lastIndexOf("\n", r.start - 1) + 1;
		const nl = text.indexOf("\n", r.end);
		const eol = nl === -1 ? text.length : nl;
		const before = text.slice(lineStart, r.start);
		const after = text.slice(r.end, eol);
		if (before.trim() === "" && after.trim() === "") {
			cuts.push([lineStart, eol === text.length ? eol : eol + 1]); // own line(s): drop line
		} else if (before.trim() !== "" && after.trim() === "") {
			let start = r.start;
			while (start > lineStart && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
			cuts.push([start, eol]); // trailing comment: also eat leftover spaces
		} else {
			cuts.push([r.start, r.end]);
		}
	}
	cuts.sort((a, b) => b[0] - a[0]);
	let out = text;
	for (const [s, e] of cuts) out = out.slice(0, s) + out.slice(e);
	return out;
}

function scriptKind(file: string): string {
	return /\.tsx?$/.test(file) ? "ts" : "js";
}

const proc = Bun.spawnSync(["git", "ls-files", "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.mts", "*.cts"]);
const files = proc.stdout.toString().split("\n").filter(Boolean).filter((f) => !EXCLUDE.some((re) => re.test(f)));

let filesChanged = 0;
let commentsRemoved = 0;
const changedList: string[] = [];
const failed: string[] = [];
for (const file of files) {
	const original = await Bun.file(file).text();
	const kind = scriptKind(file);
	let text = original;
	let removedHere = 0;
	for (let pass = 0; pass < 4; pass++) {
		let ranges: Comment[];
		try {
			ranges = collect(text, kind).filter((r) => !isKept(text, r));
		} catch (err) {
			failed.push(`${file}: parse error ${(err as Error).message.slice(0, 120)}`);
			ranges = [];
			break;
		}
		if (ranges.length === 0) break;
		removedHere += ranges.length;
		text = stripPass(text, kind);
	}
	// verify: re-parse; every remaining comment must be a keep-pragma
	let remaining: Comment[] = [];
	try {
		remaining = collect(text, kind).filter((r) => !isKept(text, r));
	} catch {
		/* already reported */
	}
	if (remaining.length > 0) {
		console.error(`VERIFY-FAIL ${file}: ${remaining.length} comment(s) survived`);
		process.exit(1);
	}
	if (text !== original) {
		filesChanged++;
		commentsRemoved += removedHere;
		changedList.push(`${file}: ${removedHere}`);
		if (APPLY) await Bun.write(file, text);
	}
}
console.log(JSON.stringify({ filesScanned: files.length, filesChanged, commentsRemoved, failed, changed: changedList }, null, 1));
