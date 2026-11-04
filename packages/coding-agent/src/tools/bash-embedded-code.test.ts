import { expect, test } from "bun:test";
import {
	detectBashKernelCell,
	findBashCodeCells,
	findBashFileWrites,
	isBashKernelCellMixed,
} from "./bash-embedded-code";

const codes = (command: string) => findBashCodeCells(command).map(cell => cell.code);

test("Python heredocs expose source without kernel rendering", () => {
	const command = "python <<'EOF'\nprint('ok')\nEOF";
	expect(codes(command)).toEqual(["print('ok')"]);
	expect(findBashCodeCells(command)[0]?.kernel).toBe(false);
	expect(detectBashKernelCell(command)).toBeUndefined();
	expect(codes("cd sub && python3 - <<EOF\nx = 1\nEOF")).toEqual(["x = 1"]);
});

test("node and bun heredocs and code words retain JavaScript kernel routing", () => {
	for (const command of [
		"node <<'JS'\nconsole.log(1)\nJS",
		"bun - <<'JS'\nconsole.log(1)\nJS",
		'node -e "console.log(1)"',
		"bun -e 'console.log(1)'",
	]) {
		expect(detectBashKernelCell(command)).toEqual({ language: "js", code: "console.log(1)" });
	}
});

test("native Python invocation forms never acquire implicit kernel affordances", () => {
	for (const command of [
		"python script.py",
		"python -m http.server",
		"python -c 'print(1)' extra",
		"python -u -c 'print(1)'",
		"python -i -c 'print(1)'",
		"python3 -u - <<'PY'\nprint(1)\nPY",
		".venv/bin/python -c 'print(1)'",
		"/usr/bin/python3.12 -c 'print(1)'",
		"python3.13 -c 'print(1)'",
		"python2.7 -c 'print(1)'",
		"pypy3 - <<EOF\nprint(1)\nEOF",
		"FOO=1 python -c 'print(1)'",
		"env python -c 'print(1)'",
		"\\python -c 'print(1)'",
		"timeout 5 python -c 'print(1)'",
		"time -p python -c 'print(1)'",
		"nohup python -c 'print(1)'",
		"command python -c 'print(1)'",
		"builtin python -c 'print(1)'",
	]) {
		expect(detectBashKernelCell(command), command).toBeUndefined();
		expect(isBashKernelCellMixed(command), command).toBe(false);
		expect(
			findBashCodeCells(command).some(cell => cell.kernel),
			command,
		).toBe(false);
	}
});

test("kernel rendering skips preceding native Python and selects the JavaScript cell", () => {
	const command = "python -c 'print(1)' && node -e 'console.log(2)'";
	expect(detectBashKernelCell(command)).toEqual({ language: "js", code: "console.log(2)" });
	expect(isBashKernelCellMixed(command)).toBe(true);
	expect(findBashCodeCells(command).map(cell => [cell.language, cell.kernel])).toEqual([
		["python", false],
		["js", true],
	]);
});

test("unsupported JavaScript interpreter options do not claim kernel routing", () => {
	expect(detectBashKernelCell("node -c 'x'")).toBeUndefined();
	expect(detectBashKernelCell("node --input-type=module <<'JS'\nconsole.log(1)\nJS")).toBeUndefined();
	expect(detectBashKernelCell("node -u <<'JS'\nconsole.log(1)\nJS")).toBeUndefined();
});

test("program input redirections are not confused with inline interpreter source", () => {
	for (const command of ["curl -s x | python -c 'import json'", "python -c 'import json' < in.txt"]) {
		expect(codes(command)).toEqual(["import json"]);
		expect(detectBashKernelCell(command)).toBeUndefined();
	}
	const js = 'cat input.bin | node -e "process.stdin.resume()"';
	expect(detectBashKernelCell(js)).toEqual({ language: "js", code: "process.stdin.resume()" });
	expect(isBashKernelCellMixed(js)).toBe(true);
});

test("interpreter paths and versions expose source for AST checks", () => {
	for (const executable of [".venv/bin/python", "/usr/bin/python3.12", "python3.13", "pypy3", "python2.7"]) {
		expect(
			findBashCodeCells(`${executable} -c 'print(1)'`).map(cell => [cell.language, cell.code, cell.kernel]),
		).toEqual([["python", "print(1)", false]]);
	}
	expect(codes("./node_modules/.bin/node -e 'f()'")).toEqual(["f()"]);
	expect(codes("python3-config --includes")).toEqual([]);
});

test("stdin programs with argv expose code while script and module heredocs remain data", () => {
	expect(codes("python3 - \"$f\" <<'PY'\nimport sys\nPY")).toEqual(["import sys"]);
	expect(codes("python \"$f\" <<'EOF'\nrow,1\nEOF")).toEqual([]);
	expect(codes("python -m json.tool <<EOF\n{}\nEOF")).toEqual([]);
	expect(codes("python <<'PY' script.py\nprint(1)\nPY")).toEqual([]);
	expect(codes("python3 <<< 'print(1)'")).toEqual(["print(1)"]);
	expect(codes("python -e 'x'")).toEqual([]);
});

test("runner argv exposes the nested interpreter but ordinary arguments do not", () => {
	expect(codes("uv run --with pandas python - <<'PY'\nimport pandas\nPY")).toEqual(["import pandas"]);
	expect(codes("sudo -E env FOO=1 python3 -c 'print(1)'")).toEqual(["print(1)"]);
	expect(codes("ssh host python3 - <<'PY'\nprint(2)\nPY")).toEqual(["print(2)"]);
	expect(codes("find . -name '*.py' -exec python3 -c 'import sys' {} \\;")).toEqual(["import sys"]);
	expect(codes("python script.py python -c 'x'")).toEqual([]);
	expect(codes("echo uv run python -c 'print(1)' ")).toEqual([]);
});

test("mixed and unfinished heredocs retain only their displayed source", () => {
	expect(codes("printf before\npython <<'PY'\nprint(1)\nPY\nprintf after")).toEqual(["print(1)"]);
	expect(codes("printf before\npython <<'PY'\nprint(1)")).toEqual(["print(1)"]);
	expect(codes("python <<'PY'\nprint(1)\nx = 2")).toEqual(["print(1)\nx = 2"]);
	expect(codes("python <<'PY'\nprint(1)\n")).toEqual(["print(1)"]);
	expect(codes("python -c 'print(1")).toEqual(["print(1"]);
	expect(codes("echo \"$(python -c 'import os")).toEqual(["import os"]);
});

test("shell operators and wrappers keep JavaScript mixed rendering", () => {
	for (const command of [
		"node -e 'console.log(1)' | sed -n 1p",
		"node -e 'console.log(1)' > output.txt",
		"FOO=1 node -e 'console.log(1)'",
		"timeout 5 node -e 'console.log(1)'",
		"(node -e 'console.log(1)')",
		"x=$(node -e 'console.log(1)')",
		"{ node -e 'console.log(1)'; }",
		"if true; then\n  node -e 'console.log(1)'\nfi",
	]) {
		expect(detectBashKernelCell(command)).toEqual({ language: "js", code: "console.log(1)" });
		expect(isBashKernelCellMixed(command)).toBe(true);
	}
	expect(detectBashKernelCell("env node -e 'console.log(1)'")).toBeUndefined();
	expect(detectBashKernelCell("sudo node -e 'console.log(1)'")).toBeUndefined();
	expect(detectBashKernelCell("\\node -e 'console.log(1)'")).toEqual({ language: "js", code: "console.log(1)" });
	expect(isBashKernelCellMixed("\\node -e 'console.log(1)'")).toBe(false);
});

test("environment assignment words do not swallow Python source", () => {
	for (const prefix of [
		"FOO=1",
		"P=$HOME",
		"FOO='a b'",
		"FOO=1\\ 2",
		"A=1 B+=2",
		"timeout --preserve-status 5",
		"time -p",
		"nohup",
		"command",
		"builtin",
	]) {
		expect(codes(`${prefix} python -c 'print(1)'`)).toEqual(["print(1)"]);
	}
	expect(codes("FOO=1 python <<'PY'\nprint(1)\nPY")).toEqual(["print(1)"]);
});

test("subshell and compound command boundaries retain every Python program", () => {
	expect(codes("(python -c 'print(1)') && python -c 'print(2)'")).toEqual(["print(1)", "print(2)"]);
	expect(codes("x=$(python -c 'print(1)')")).toEqual(["print(1)"]);
	expect(codes("{ python -c 'print(1)'; }")).toEqual(["print(1)"]);
	expect(codes("if true; then\n  python -c 'print(1)'\nfi")).toEqual(["print(1)"]);
});

test("plain shell and empty interpreter heredocs expose no source region", () => {
	for (const command of [
		"rg -n foo src",
		"sed -i 's/a/b/' f.py",
		"python <<'PY'\nPY",
		"python <<'PY'\nPY\n",
		"\tpython <<-EOF\n\tEOF",
	]) {
		expect(findBashCodeCells(command)).toEqual([]);
	}
});

test("tab-stripping heredocs expose the program the interpreter receives", () => {
	expect(codes("\tpython <<-EOF\n\ty = 2\n\tEOF")).toEqual(["y = 2"]);
	expect(codes("python <<-EOF\n\tprint(1)\n\t\tx = 2\n\tEOF")).toEqual(["print(1)\nx = 2"]);
});

test("CRLF heredoc delimiters are not displayed as Python source", () => {
	expect(codes("python <<'PY'\r\nprint(1)\r\nPY\r\n")).toEqual(["print(1)\r"]);
});

test("shell word extraction matches the code argument after quote removal", () => {
	expect(codes("python -c $'print(\\'a\\')\\n\\tB\\x41\\101\\u00e9'")).toEqual(["print('a')\n\tBAAé"]);
	expect(codes("python -c print\\(1\\)")).toEqual(["print(1)"]);
	expect(codes("python -c 'a'\\''b'")).toEqual(["a'b"]);
	expect(codes('python -c "a\\"b"')).toEqual(['a"b']);
	expect(codes("python -c print(1)")).toEqual([]);
	expect(codes("python -c `echo x`")).toEqual([]);
});

test("findBashCodeCells reports every cell with its raw code span in source order", () => {
	const command =
		"python -c 'print(1)' && node -e 'console.log(2)' && python <<'PY'\nprint(3)\nPY\npython <<'PY'\nprint(4)\nPY";
	const cells = findBashCodeCells(command);
	expect(cells.map(cell => [cell.language, cell.code])).toEqual([
		["python", "print(1)"],
		["js", "console.log(2)"],
		["python", "print(3)"],
		["python", "print(4)"],
	]);
	// Spans address the raw source (quotes included for -c words) so a renderer can splice around them.
	expect(cells.map(cell => command.slice(cell.start, cell.end))).toEqual([
		"'print(1)'",
		"'console.log(2)'",
		"print(3)",
		"print(4)",
	]);
	expect(cells.every((cell, index) => index === 0 || cell.start >= cells[index - 1]!.end)).toBe(true);
});

test("spans are UTF-16 offsets into the command", () => {
	const command = "echo 😀é && python <<-EOF | grep x\n\tprint('ü')\n\tEOF\necho";
	const [cell] = findBashCodeCells(command);
	expect(command.slice(cell!.start, cell!.end)).toBe("\tprint('ü')");
	expect(cell!.code).toBe("print('ü')");
});

test("interpreter-looking text inside a heredoc body is not a second cell", () => {
	const command = "python <<'PY'\nprint('python -c \"inner\"')\nx = 1\nPY\necho done";
	expect(codes(command)).toEqual(["print('python -c \"inner\"')\nx = 1"]);
});

test("extracts a plain truncate heredoc write", () => {
	expect(findBashFileWrites("cat > src/foo.ts <<'EOF'\nconst x: number = 1;\nEOF")).toEqual([
		{ path: "src/foo.ts", code: "const x: number = 1;", start: 25, end: 45 },
	]);
});

test("extracts an append heredoc write", () => {
	expect(findBashFileWrites("cat >> src/foo.ts <<EOF\nconst y = 2;\nEOF").map(write => write.code)).toEqual([
		"const y = 2;",
	]);
});

test("strips leading tabs for the tab-stripping heredoc form", () => {
	expect(
		findBashFileWrites("cat > src/foo.ts <<-EOF\n\tconst z = 3;\n\t\treturn z;\n\tEOF").map(write => write.code),
	).toEqual(["const z = 3;\nreturn z;"]);
});

test("removes shell quoting from written paths", () => {
	expect(
		findBashFileWrites("cat > 'src/quoted file.ts' <<EOF\nexport const value = 1;\nEOF").map(write => write.path),
	).toEqual(["src/quoted file.ts"]);
	expect(findBashFileWrites('cat > "$dir"/new.py <<EOF\nx = 1\nEOF').map(write => write.path)).toEqual([
		"$dir/new.py",
	]);
	expect(findBashFileWrites("tee my\\ file.py <<EOF\nx = 1\nEOF").map(write => write.path)).toEqual(["my file.py"]);
});

test("extracts cat with the redirect after the heredoc opener", () => {
	expect(
		findBashFileWrites("cat <<'EOF' > src/after.ts\nexport const after = true;\nEOF").map(write => write.code),
	).toEqual(["export const after = true;"]);
});

test("extracts tee append writes", () => {
	expect(findBashFileWrites("tee -a src/tee.ts <<'EOF'\nexport const tee = true;\nEOF")).toEqual([
		{ path: "src/tee.ts", code: "export const tee = true;", start: 26, end: 50 },
	]);
});

test("extracts multiple writes in source order", () => {
	const command = "cat > first.ts <<EOF\nfirst\nEOF\ntee -- second.ts <<EOF\nsecond\nEOF";
	expect(findBashFileWrites(command).map(write => [write.path, write.code])).toEqual([
		["first.ts", "first"],
		["second.ts", "second"],
	]);
});

test("does not report interpreter heredocs or concatenations as file writes", () => {
	expect(findBashFileWrites("python <<'PY'\nprint('not a file write')\nPY")).toEqual([]);
	expect(findBashFileWrites("node <<'JS' > out.txt\nconsole.log(1)\nJS")).toEqual([]);
	expect(findBashFileWrites("cat a.ts b.ts <<EOF > out.ts\nx\nEOF")).toEqual([]);
});

test("keeps an unterminated heredoc body through the end of the command", () => {
	expect(findBashFileWrites("cat > src/open.ts <<EOF\nexport const open = true;")).toEqual([
		{ path: "src/open.ts", code: "export const open = true;", start: 24, end: 49 },
	]);
});
