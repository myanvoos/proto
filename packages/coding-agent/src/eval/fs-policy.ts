/**
 * Shared filesystem-tracking policy for the eval FS surfaces. The host walker
 * (eval/cell-file-diff.ts) and the JS kernel tracker (eval/js/shared/fs-tracker.ts)
 * must prune identically, or one side reports files the other already covered
 * and every write shows up twice. The Python prelude (eval/py/prelude.py) keeps
 * a cross-language mirror of these lists; update it in the same change.
 */

// Cache/build noise by directory-name component.
export const PRUNED_DIRS: ReadonlySet<string> = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".cache",
	".cargo",
	".rustup",
	".bun",
	".npm",
	".local",
	"target",
	"build",
	"dist",
	".next",
	".nuxt",
	".output",
	".turbo",
	".parcel-cache",
	"coverage",
]);

export const SKIPPED_SUFFIXES: readonly string[] = [".pyc", ".pyo"];
