import { expect, test } from "bun:test";
import { detectBashKernelCell, isBashKernelCellMixed } from "./bash-kernel-cell";

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
test("real-interpreter invocations are not cells", () => {
	expect(detectBashKernelCell("python foo.py")).toBeUndefined();
	expect(detectBashKernelCell("python3 foo.py <<EOF\nx\nEOF")).toBeUndefined();
	expect(detectBashKernelCell("python -c 'print(1)' extra")).toBeUndefined();
	expect(detectBashKernelCell("python -m http.server")).toBeUndefined();
	expect(detectBashKernelCell("python -e 'x'")).toBeUndefined();
	expect(detectBashKernelCell("node -c 'x'")).toBeUndefined();
	expect(detectBashKernelCell("python -i -c 'x'")).toBeUndefined();
	expect(detectBashKernelCell("node --input-type=module <<'JS'\nconsole.log(1)\nJS")).toBeUndefined();
	expect(detectBashKernelCell("node -u <<'JS'\nconsole.log(1)\nJS")).toBeUndefined();
});
test("interpreter options the bridge passes through still route to a cell", () => {
	expect(detectBashKernelCell("python -u -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("python3 -u - <<'PY'\nprint(2)\nPY")).toEqual({ language: "python", code: "print(2)" });
	expect(detectBashKernelCell("bun - <<'JS'\nconsole.log(3)\nJS")).toEqual({ language: "js", code: "console.log(3)" });
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

test("shell operators after -c/-e cells are mixed, while extra interpreter args are not cells", () => {
	const pyPipeline = "python -c 'print(1)' | sed -n 1p";
	expect(detectBashKernelCell(pyPipeline)).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed(pyPipeline)).toBe(true);

	const jsRedirect = "node -e 'console.log(1)' > output.txt";
	expect(detectBashKernelCell(jsRedirect)).toEqual({ language: "js", code: "console.log(1)" });
	expect(isBashKernelCellMixed(jsRedirect)).toBe(true);

	expect(detectBashKernelCell("python -c 'print(1)' extra")).toBeUndefined();
	expect(detectBashKernelCell("python <<'PY' script.py\nprint(1)\nPY")).toBeUndefined();
});
test("plain shell is not a cell", () => {
	expect(detectBashKernelCell("rg -n foo src")).toBeUndefined();
	expect(detectBashKernelCell("sed -i 's/a/b/' f.py")).toBeUndefined();
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
});

test("subshell, command substitution and brace groups wrapping a cell are detected as mixed", () => {
	expect(detectBashKernelCell("(python -c 'print(1)')")).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed("(python -c 'print(1)')")).toBe(true);
	expect(detectBashKernelCell("x=$(python -c 'print(1)')")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("{ python -c 'print(1)'; }")).toEqual({ language: "python", code: "print(1)" });
	expect(detectBashKernelCell("(python -c 'print(1)') && python -c 'print(2)'")).toEqual({
		language: "python",
		code: "print(1)",
	});
});

test("backslash-escaped interpreter name is a pure cell", () => {
	expect(detectBashKernelCell("\\python -c 'print(1)'")).toEqual({ language: "python", code: "print(1)" });
	expect(isBashKernelCellMixed("\\python -c 'print(1)'")).toBe(false);
});

test("empty heredoc bodies are not cells", () => {
	// The heredoc closes on the delimiter line; the kernel receives empty code.
	// Detection previously leaked the delimiter through as phantom code.
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
