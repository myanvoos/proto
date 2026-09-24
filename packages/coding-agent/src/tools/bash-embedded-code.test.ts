import { expect, test } from "bun:test";
import {
	detectBashKernelCell,
	findBashCodeCells,
	findBashFileWrites,
	isBashKernelCellMixed,
} from "./bash-embedded-code";

const codes = (command: string) => findBashCodeCells(command).map(cell => cell.code);

test("quoted heredoc python", () => {
	const c = detectBashKernelCell("python <<'EOF'\nedit('a.py','x','y')\nprint('ok')\nEOF");
	expect(c?.language).toBe("python");
	expect(c?.code).toBe("edit('a.py','x','y')\nprint('ok')");
});
test("python3 - heredoc with cd prefix", () => {
	const c = detectBashKernelCell("cd sub && python3 - <<EOF\nx = 1\nEOF");
	expect(c).toEqual({ language: "python", code: "x = 1" });
});
test("node heredoc", () => {
	expect(detectBashKernelCell("node <<'JS'\nconsole.log(1)\nJS")?.code).toBe("console.log(1)");
});

test("bun heredoc and -e use the JavaScript kernel cell shape", () => {
	expect(detectBashKernelCell("bun <<'JS'\nfunction f() {}\nJS")).toEqual({
		language: "js",
		code: "function f() {}",
	});
	expect(detectBashKernelCell("bun -e 'console.log(1)'")).toEqual({
		language: "js",
		code: "console.log(1)",
	});
});
test("python -c single quoted, node -e double quoted", () => {
	expect(detectBashKernelCell('python -c \'edit("a","b","c")\'')?.code).toBe('edit("a","b","c")');
	expect(detectBashKernelCell('node -e "console.log(1)"')?.code).toBe("console.log(1)");
});
test("real-interpreter invocations are not kernel cells", () => {
	expect(detectBashKernelCell("python foo.py")).toBeUndefined();
	expect(detectBashKernelCell("python3 foo.py <<EOF\nx\nEOF")).toBeUndefined();
	expect(detectBashKernelCell("python -c 'print(1)' extra")).toBeUndefined();
	expect(detectBashKernelCell("python -m http.server")).toBeUndefined();
	expect(detectBashKernelCell("python -e 'x'")).toBeUndefined();
	expect(detectBashKernelCell("node -c 'x'")).toBeUndefined();
	expect(detectBashKernelCell("python -i -c 'x'")).toBeUndefined();
	expect(detectBashKernelCell("node --input-type=module <<'JS'\nconsole.log(1)\nJS")).toBeUndefined();
	expect(detectBashKernelCell("node -u <<'JS'\nconsole.log(1)\nJS")).toBeUndefined();
	// `-c` with program input on stdin falls through to a real interpreter.
	expect(detectBashKernelCell("curl -s x | python -c 'import json'")).toBeUndefined();
	expect(detectBashKernelCell("python -c 'x' < in.txt")).toBeUndefined();
});
test("interpreter options the bridge passes through still route to a cell", () => {
	expect(detectBashKernelCell("python -u -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("python3 -u - <<'PY'\nprint(2)\nPY")).toEqual({ language: "python", code: "print(2)" });
	expect(detectBashKernelCell("bun - <<'JS'\nconsole.log(3)\nJS")).toEqual({ language: "js", code: "console.log(3)" });
});

test("real interpreters still expose their program as code", () => {
	// Paths, versions and implementations are all interpreters; none dispatch to the kernel.
	for (const command of [
		".venv/bin/python <<'EOF'\nprint(1)\nEOF",
		"/usr/bin/python3.12 -c 'print(1)'",
		"pypy3 - <<EOF\nprint(1)\nEOF",
		"python -i -c 'print(1)'",
	]) {
		expect(findBashCodeCells(command).map(cell => [cell.language, cell.code, cell.kernel])).toEqual([
			["python", "print(1)", false],
		]);
	}
	expect(findBashCodeCells("./node_modules/.bin/node -e 'f()'").map(cell => [cell.language, cell.code])).toEqual([
		["js", "f()"],
	]);
	expect(codes("python3-config --includes")).toEqual([]);
});

test("a stdin program with argv is code, while a script's heredoc is its data", () => {
	expect(codes("python3 - \"$f\" <<'PY'\nimport sys\nPY")).toEqual(["import sys"]);
	expect(codes("python \"$f\" <<'EOF'\nrow,1\nEOF")).toEqual([]);
	expect(codes("python -m json.tool <<EOF\n{}\nEOF")).toEqual([]);
	expect(codes("python3 <<< 'print(1)'")).toEqual(["print(1)"]);
});

test("runners reach the interpreter named in their argv", () => {
	expect(codes("uv run --with pandas python - <<'PY'\nimport pandas\nPY")).toEqual(["import pandas"]);
	expect(codes("sudo -E env FOO=1 python3 -c 'print(1)'")).toEqual(["print(1)"]);
	expect(codes("ssh host python3 - <<'PY'\nprint(2)\nPY")).toEqual(["print(2)"]);
	expect(codes("find . -name '*.py' -exec python3 -c 'import sys' {} \\;")).toEqual(["import sys"]);
	// A command that is itself an interpreter owns its argv.
	expect(codes("python script.py python -c 'x'")).toEqual([]);
});

test("mixed heredocs retain the kernel payload and report surrounding shell", () => {
	const command = "printf before\npython <<'PY'\nprint(1)\nPY\nprintf after";
	expect(detectBashKernelCell(command)).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed(command)).toBe(true);
	expect(isBashKernelCellMixed("python <<'PY'\nprint(1)\nPY")).toBe(false);

	const pending = "printf before\npython <<'PY'\nprint(1)";
	expect(detectBashKernelCell(pending)).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed(pending)).toBe(true);
});

test("partial commands yield the code streamed so far", () => {
	expect(detectBashKernelCell("python <<'PY'\nprint(1)\nx = 2")?.code).toBe("print(1)\nx = 2");
	expect(detectBashKernelCell("python <<'PY'\nprint(1)\n")?.code).toBe("print(1)");
	expect(detectBashKernelCell("python -c 'print(1")?.code).toBe("print(1");
	expect(codes("echo \"$(python -c 'import os")).toEqual(["import os"]);
});

test("shell operators after -c/-e cells are mixed, while extra interpreter args are not cells", () => {
	const pyPipeline = "python -c 'print(1)' | sed -n 1p";
	expect(detectBashKernelCell(pyPipeline)).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed(pyPipeline)).toBe(true);

	const jsRedirect = "node -e 'console.log(1)' > output.txt";
	expect(detectBashKernelCell(jsRedirect)).toEqual({ language: "js", code: "console.log(1)" });
	expect(isBashKernelCellMixed(jsRedirect)).toBe(true);

	expect(detectBashKernelCell("python -c 'print(1)' extra")).toBeUndefined();
	expect(detectBashKernelCell("python <<'PY' script.py\nprint(1)\nPY")).toBeUndefined();
	expect(isBashKernelCellMixed("python -c 'print(1)' # note")).toBe(true);
});
test("plain shell is not a cell", () => {
	expect(findBashCodeCells("rg -n foo src")).toEqual([]);
	expect(findBashCodeCells("sed -i 's/a/b/' f.py")).toEqual([]);
});
test("<<- strips leading tabs on terminator", () => {
	expect(detectBashKernelCell("\tpython <<-EOF\n\ty = 2\n\tEOF")?.language).toBe("python");
});

test("env-assignment prefixes stay cells because the shell builtin dispatches them", () => {
	// The embedded shell runs `VAR=… python …` through the python builtin, so the
	// renderer must keep kernel affordances; the assignment makes it mixed.
	expect(detectBashKernelCell("FOO=1 python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed("FOO=1 python -c 'print(1)'")).toBe(true);
	expect(detectBashKernelCell("P=$HOME python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("FOO='a b' python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("FOO=1\\ 2 python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("A=1 B+=2 python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("FOO=1 python <<'PY'\nprint(1)\nPY")).toEqual({ language: "python", code: "print(1)" });
	// `env` execs a real interpreter — no cell.
	expect(detectBashKernelCell("env python -c 'print(1)'")).toBeUndefined();
});

test("kernel-dispatching wrapper prefixes keep the cell rendering", () => {
	expect(detectBashKernelCell("timeout 5 python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("timeout --preserve-status 5 python -c 'print(1)'")).toEqual({
		language: "python",
		code: "print(1)",
	});
	expect(detectBashKernelCell("time -p python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("nohup python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("command python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("builtin python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed("timeout 5 python -c 'print(1)'")).toBe(true);
	// Non-dispatching prefixes must not render as cells: they exec a real interpreter.
	expect(detectBashKernelCell("sudo python -c 'print(1)'")).toBeUndefined();
	expect(detectBashKernelCell("env python -c 'print(1)'")).toBeUndefined();
	expect(detectBashKernelCell("timeout 5 sudo python -c 'print(1)'")).toBeUndefined();
});

test("subshell, command substitution and brace groups wrapping a cell are detected as mixed", () => {
	expect(detectBashKernelCell("(python -c 'print(1)')")).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed("(python -c 'print(1)')")).toBe(true);
	expect(detectBashKernelCell("x=$(python -c 'print(1)')")).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed("x=$(python -c 'print(1)')")).toBe(true);
	expect(detectBashKernelCell("{ python -c 'print(1)'; }")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("(python -c 'print(1)') && python -c 'print(2)'")).toEqual({
		language: "python",
		code: "print(1)",
	});
	expect(detectBashKernelCell("if true; then\n  python -c 'print(1)'\nfi")?.code).toBe("print(1)");
});

test("backslash-escaped interpreter name is a pure cell", () => {
	expect(detectBashKernelCell("\\python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed("\\python -c 'print(1)'")).toBe(false);
});

test("empty heredoc bodies are not cells", () => {
	// The heredoc closes on the delimiter line; the kernel receives empty code.
	expect(detectBashKernelCell("python <<'PY'\nPY")).toBeUndefined();
	expect(detectBashKernelCell("python <<'PY'\nPY\n")).toBeUndefined();
	expect(detectBashKernelCell("\tpython <<-EOF\n\tEOF")).toBeUndefined();
});

test("<<- strips leading tabs from the displayed body like the shell does", () => {
	expect(detectBashKernelCell("python <<-EOF\n\tprint(1)\n\t\tx = 2\n\tEOF")).toEqual({
		language: "python",
		code: "print(1)\nx = 2",
	});
});

test("CRLF heredoc terminators close the cell", () => {
	// The embedded shell accepts a delimiter line ending in \r; rendering the
	// delimiter as code would disagree with what the kernel executes.
	const cell = detectBashKernelCell("python <<'PY'\r\nprint(1)\r\nPY\r\n");
	expect(cell).toEqual({ language: "python", code: "print(1)\r" });
});

test("shell word extraction matches the argv the interpreter receives", () => {
	// $'...' ANSI-C escapes are stripped by the shell before dispatch.
	expect(detectBashKernelCell("python -c $'print(\\'a\\')\\n\\tB\\x41\\101\\u00e9'")).toEqual({
		language: "python",
		code: "print('a')\n\tBAAé",
	});
	// Backslash-escaped words unescape.
	expect(detectBashKernelCell("python -c print\\(1\\)")).toEqual({ language: "python", code: "print(1)" });
	// Quoted segments concatenate into one argv word.
	expect(detectBashKernelCell("python -c 'a'\\''b'")).toEqual({ language: "python", code: "a'b" });
	// Escaped quotes inside double quotes keep existing behavior.
	expect(detectBashKernelCell('python -c "a\\"b"')).toEqual({ language: "python", code: 'a"b' });
	// Unquoted parens are bash syntax errors, not cells.
	expect(detectBashKernelCell("python -c print(1)")).toBeUndefined();
	// Backtick command substitution is not statically knowable.
	expect(detectBashKernelCell("python -c `echo x`")).toBeUndefined();
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
