import { initThemeSync, theme } from "../../modes/theme/theme";
import { renderPythonAstLines } from "./python-ast";

initThemeSync();

const ANSI = /\u001b\[[0-9;]*m/g;
function render(source: string, width = 120): string[] {
	return renderPythonAstLines(source, theme, width) ?? [];
}
function plain(source: string, width = 120): string[] {
	return render(source, width).map(line => line.replace(ANSI, ""));
}

test("py cells render a structural outline with kinds, names and line refs", () => {
	const lines = plain(`def greet(name):
    return name

class Runner(Base):
    def run(self, n):
        return n

cache = {}
`);
	expect(lines[0]).toContain("Module");
	expect(lines).toContainEqual(expect.stringContaining("├─ def greet(name) ·L1"));
	expect(lines).toContainEqual(expect.stringContaining("├─ class Runner (Base) ·L4"));
	expect(lines).toContainEqual(expect.stringContaining("def run(self, n) ·L5"));
	expect(lines).toContainEqual(expect.stringContaining("└─ cache ← {}"));
});

test("code-like content inside strings does not corrupt the outline", () => {
	const lines = plain(`tricky = "class Fake: ; if x: pass"
template = f"{a if b else c} while d"
def real():
    return 1
`);
	expect(lines.filter(line => /─ (class|if|while) /.test(line))).toEqual([]);
	expect(lines).toContainEqual(expect.stringContaining("└─ def real() ·L3"));
	expect(lines).toHaveLength(5); // header + 2 assigns + def + its return
});

test("margin note comments attach to the following node", () => {
	const lines = plain(`#@ shared cache
#@? should this be lru?
CACHE = {}
`);
	expect(lines).toContainEqual(expect.stringContaining("▌ shared cache"));
	expect(lines).toContainEqual(expect.stringContaining("▌ should this be lru?"));
	const noteIndex = lines.findIndex(line => line.includes("shared cache"));
	const cacheIndex = lines.findIndex(line => line.includes("CACHE ← {}"));
	expect(noteIndex).toBeGreaterThanOrEqual(0);
	expect(cacheIndex).toBe(noteIndex + 2);
});

test("docstring first line becomes the doc suffix on the def", () => {
	const lines = plain(`def greet(name):
    """Greet a user by name.

    Longer explanation.
    """
    return name
`);
	expect(lines).toContainEqual(expect.stringContaining("def greet(name) — Greet a user by name."));
	// The docstring must not also appear as an expr child.
	expect(lines.filter(line => line.includes("└─ expr") || line.includes("├─ expr"))).toEqual([]);
});

test("imports summarize modules and bindings", () => {
	const lines = plain(`import os
import os.path as osp, sys
from collections import OrderedDict as OD
`);
	expect(lines).toContainEqual(expect.stringContaining("import os"));
	expect(lines).toContainEqual(expect.stringContaining("import os.path as osp, sys"));
	expect(lines).toContainEqual(expect.stringContaining("from-import collections OrderedDict as OD"));
});

test("control flow nests: elif chains, try/except/finally, loops, match cases", () => {
	const lines = plain(`def handle(req):
    if req.a:
        return 1
    elif req.b:
        return 2
    else:
        return 3
    try:
        step()
    except ValueError as err:
        raise
    except (TypeError, KeyError):
        pass
    finally:
        reset()
    for item in req.items:
        pass
    while req.more:
        break
    match req.m:
        case "GET":
            pass
        case _:
            pass
`);
	const text = lines.join("\n");
	expect(text).toContain("if req.a");
	expect(text).toContain("elif req.b");
	expect(text).toContain("except ValueError as err");
	expect(text).toContain("except (TypeError, KeyError)");
	expect(text).toContain("finally");
	expect(text).toContain("for item req.items");
	expect(text).toContain("while req.more");
	expect(text).toContain("match req.m");
	expect(text).toContain('case "GET"');
	expect(text).toContain("case _");
	const ifIndex = lines.findIndex(line => line.includes("if req.a"));
	const elifIndex = lines.findIndex(line => line.includes("elif req.b"));
	expect(ifIndex).toBeGreaterThanOrEqual(0);
	expect(elifIndex).toBeGreaterThan(ifIndex);
});

test("augmented assignment renders as target op value", () => {
	const lines = plain(`counter += 1
total //= step
`);
	expect(lines).toContainEqual(expect.stringContaining("counter += 1"));
	expect(lines).toContainEqual(expect.stringContaining("total //= step"));
});

test("decorators annotate the def they precede", () => {
	const lines = plain(`@cached
def compute(x):
    return x
`);
	const line = lines.find(l => l.includes("def compute(x)"));
	expect(line).toBeDefined();
	expect(line).toContain("@cached");
});

test("async defs and async clauses keep their async prefix", () => {
	const lines = plain(`async def fetch(url):
    async with session.get(url) as resp:
        data = await resp.json()
    async for chunk in stream:
        pass
    return data
`);
	expect(lines).toContainEqual(expect.stringContaining("async def fetch(url)"));
	expect(lines).toContainEqual(expect.stringContaining("async with session.get(url) as resp"));
	expect(lines).toContainEqual(expect.stringContaining("async for chunk stream"));
});

test("annotated assignments surface the annotation", () => {
	const lines = plain(`CACHE: dict[str, int] = {}
`);
	expect(lines).toContainEqual(expect.stringContaining("CACHE ← dict[str, int] ← {}"));
});

test("empty and unparseable input yield null so the renderer falls back to raw code", () => {
	expect(renderPythonAstLines("", theme, 100)).toBeNull();
	expect(renderPythonAstLines("   \n  ", theme, 100)).toBeNull();
	expect(renderPythonAstLines("))) ??? @@@ (((", theme, 100)).toBeNull();
});
