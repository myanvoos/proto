import { describe, expect, test } from "bun:test";
import { checkBashCommandAllowlist, READ_ONLY_EXPLORATORY_COMMANDS } from "./bash-allowlist";

function allow(command: string): void {
	const verdict = checkBashCommandAllowlist(command, READ_ONLY_EXPLORATORY_COMMANDS);
	expect(verdict.allowed, `${command} -> ${verdict.reason ?? "allowed"}`).toBe(true);
}

function block(command: string): void {
	const verdict = checkBashCommandAllowlist(command, READ_ONLY_EXPLORATORY_COMMANDS);
	expect(verdict.allowed, `${command} unexpectedly allowed`).toBe(false);
	expect(verdict.reason, command).toBeString();
}

describe("checkBashCommandAllowlist", () => {
	test("allows read-only exploration commands with flags, pipes, env prefixes, and cd chains", () => {
		allow("rg pattern src/");
		allow("rg -n --hidden 'TODO' packages");
		allow('grep -rn "foo" .');
		allow("ls -la");
		allow("find . -name '*.ts' -maxdepth 3");
		allow("fd -e ts -E node_modules");
		allow("cat package.json");
		allow("tail -5 file.log");
		allow("wc -l src/*.ts");
		allow("tree -L 2");
		allow("stat package.json");
		allow("du -sh .");
		allow("cd packages && rg pattern");
		allow("rg a | wc -l");
		allow("rg a | head -20 | tail -3");
		allow("LC_ALL=C rg foo");
		allow("rg a 2>/dev/null");
		allow("rg a > /dev/null 2>&1");
		allow('rg "a > b" file');
		allow("rg 'x && rm -rf /' src");
	});

	test("blocks programs outside the allowlist", () => {
		block("rm -rf build");
		block("bun test");
		block("git status");
		block("sed -i 's/a/b/' file");
		block("echo hi | tee f.txt");
		block("sh -c 'ls'");
		block("xargs ls");
		block("mv a b");
	});

	test("blocks path-qualified program names", () => {
		block("/usr/bin/rg foo");
		block("./script.sh");
	});

	test("blocks mutation and exec flags on allowlisted programs", () => {
		block("find . -delete");
		block("find . -name '*.ts' -exec rm {} ;");
		block("find . -ok rm {} ;");
		block("find . -fls out.txt");
		block("fd -x rm");
		block("fd --exec rm");
		block("fd -X rm");
		block("rg --pre ./pre.sh pattern");
		block("rg --pre=./pre.sh pattern");
	});

	test("blocks file-writing redirections but allows /dev/null and descriptor dups", () => {
		block("rg a > out.txt");
		block("rg a >> out.txt");
		block("ls > files.txt 2>&1");
		block("rg a 2> err.txt");
		block("rg a &> all.txt");
		block("rg a <> f");
		block("cat < in.txt > out.txt");
		allow("rg a 2>&1");
		allow("rg a > /dev/null");
		allow("rg a 2>/dev/null 1>&2");
	});

	test("fails closed on unparseable shell constructs", () => {
		block("rg $(cat x)");
		block("rg `cat x`");
		block("rg 'unterminated");
		block("rg x <(ls)");
	});

	test("respects a caller-supplied allowlist subset", () => {
		const verdict = checkBashCommandAllowlist("rg a", ["ls"]);
		expect(verdict.allowed).toBe(false);
		expect(checkBashCommandAllowlist("ls -la", ["ls"]).allowed).toBe(true);
	});
});
