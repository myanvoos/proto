/**
 * Shared filesystem-tracking policy for the eval kernels. The JS tracker
 * (eval/js/shared/fs-tracker.ts) uses these lists; the Python prelude
 * (eval/py/prelude.py) keeps a cross-language mirror. Update both in the same
 * change.
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
