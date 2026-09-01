import { initThemeSync, theme } from "../../modes/theme/theme";
import { renderJavaScriptAstLines } from "./javascript-ast";

initThemeSync();

const ANSI = /\u001b\[[0-9;]*m/g;
function render(source: string, width = 120): string[] {
	return renderJavaScriptAstLines(source, theme, width) ?? [];
}
function plain(source: string, width = 120): string[] {
	return render(source, width).map(line => line.replace(ANSI, ""));
}

test("js cells render a structural outline with kinds, names and line refs", () => {
	const lines = plain(`
function greet(name) {
  return name;
}

class Runner extends Base {
  run(n) {
    return n;
  }
}

const add = (a, b) => a + b;
`);
	expect(lines[0]).toContain("Module");
	expect(lines).toContainEqual(expect.stringContaining("├─ function greet(name) ·L2"));
	expect(lines).toContainEqual(expect.stringContaining("├─ class Runner extends Base ·L6"));
	expect(lines).toContainEqual(expect.stringContaining("method run(n) ·L7"));
	expect(lines).toContainEqual(expect.stringContaining("└─ fn add(a, b) => a + b ·L12"));
});

test("code-like content inside strings, templates and regexes does not corrupt the outline", () => {
	const lines = plain(`
const tricky = "class Fake { } ; if (x) {}";
const tpl = \`emplate \${nested ? "a" : "b"} // not a note\`;
const re = /[{};]/g;
function real() {
  return 1;
}
`);
	// The string/template values appear as summarized assign values, but their
	// embedded syntax must not spawn outline nodes.
	expect(lines.filter(line => /─ (class|if) /.test(line))).toEqual([]);
	expect(lines).toContainEqual(expect.stringContaining("└─ function real() ·L5"));
	expect(lines).toHaveLength(6); // header + 3 assigns + function + its return
});

test("margin note comments attach to the following node", () => {
	const lines = plain(`
// @ shared cache note
// @? should this be lru?
const CACHE = {};
`);
	expect(lines).toContainEqual(expect.stringContaining("▌ shared cache note"));
	expect(lines).toContainEqual(expect.stringContaining("▌ should this be lru?"));
	const noteIndex = lines.findIndex(line => line.includes("shared cache note"));
	const cacheIndex = lines.findIndex(line => line.includes("CACHE ← {}"));
	expect(noteIndex).toBeGreaterThanOrEqual(0);
	expect(cacheIndex).toBe(noteIndex + 2);
});

test("JSDoc first line becomes the doc suffix on the function", () => {
	const lines = plain(`
/** Greet a user by name. */
function greet(name) {
  return name;
}
`);
	expect(lines).toContainEqual(expect.stringContaining("function greet(name) — Greet a user by name."));
});

test("imports summarize bindings and module", () => {
	const lines = plain(`
import { readFileSync, writeFileSync } from "node:fs";
import sideEffect from "mod";
import "polyfill";
`);
	expect(lines).toContainEqual(expect.stringContaining('import {readFileSync, writeFileSync} ← "node:fs"'));
	expect(lines).toContainEqual(expect.stringContaining('import sideEffect ← "mod"'));
	expect(lines).toContainEqual(expect.stringContaining('import "polyfill"'));
});

test("TS syntax in js cells parses through the TSX fallback grammar", () => {
	const lines = plain(`
interface Config {
  name: string;
  start(opts: RunOpts): void;
}

const retries: number = 3;
const load = async <T>(url: string): Promise<T> => fetch(url);
`);
	expect(lines).toContainEqual(expect.stringContaining("interface Config ·L2"));
	expect(lines).toContainEqual(expect.stringContaining("name ← string"));
	expect(lines).toContainEqual(expect.stringContaining("method start(opts: RunOpts) → void"));
	expect(lines).toContainEqual(expect.stringContaining("retries ← number ← 3"));
	expect(lines.join("\n")).toContain("fn load(url: string)");
});

test("control flow nests: if/else chains, switch cases and try/catch/finally", () => {
	const lines = plain(`
async function handle(req) {
  if (req.a) {
    return 1;
  } else if (req.b) {
    return 2;
  } else {
    return 3;
  }
  switch (req.m) {
    case "GET":
      break;
    default:
      break;
  }
  try {
    await step();
  } catch (err) {
    throw err;
  } finally {
    reset();
  }
}
`);
	const text = lines.join("\n");
	expect(text).toContain("else if req.b");
	expect(text).toContain('case "GET"');
	expect(text).toContain("catch err");
	expect(text).toContain("finally");
	const ifIndex = lines.findIndex(line => line.includes("if req.a"));
	const elseIfIndex = lines.findIndex(line => line.includes("else if req.b"));
	expect(ifIndex).toBeGreaterThanOrEqual(0);
	expect(elseIfIndex).toBeGreaterThan(ifIndex);
});

test("augmented assignment renders as target op value", () => {
	const lines = plain(`
counter += 1;
total -= step;
`);
	expect(lines).toContainEqual(expect.stringContaining("counter += 1"));
	expect(lines).toContainEqual(expect.stringContaining("total -= step"));
});

test("exports carry the modifier and default exports keep their declaration", () => {
	const lines = plain(`
export function exported() {
  return 1;
}
export const answer = 42;
export default class Impl {}
`);
	expect(lines).toContainEqual(expect.stringContaining("export function exported()"));
	expect(lines).toContainEqual(expect.stringContaining("export answer ← 42"));
	expect(lines).toContainEqual(expect.stringContaining("export default class Impl"));
});

test("empty and unparseable input yield null so the renderer falls back to raw code", () => {
	expect(renderJavaScriptAstLines("", theme, 100)).toBeNull();
	expect(renderJavaScriptAstLines("   \n  ", theme, 100)).toBeNull();
	expect(renderJavaScriptAstLines("))) ??? @@@ (((", theme, 100)).toBeNull();
});
