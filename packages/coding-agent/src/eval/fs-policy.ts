/**
 * Filesystem-tracking exclusions for JavaScript kernel cells.
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
