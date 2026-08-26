import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

/** Build-time specifier resolved to bundled host module namespaces. */
export const HOST_MODULES_SPECIFIER = "proto-host-modules";

const VIRTUAL_NAMESPACE = "proto-host-modules-build";
const packageDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(packageDir, "..", "..");

interface BundledPackage {
	readonly dir: string;
	readonly identifier: string;
}

const BUNDLED_PACKAGES: readonly BundledPackage[] = [
	{ dir: "agent", identifier: "PiAgentCore" },
	{ dir: "ai", identifier: "PiAi" },
	{ dir: "coding-agent", identifier: "PiCodingAgent" },
	{ dir: "natives", identifier: "PiNatives" },
	{ dir: "omptype", identifier: "Omptype" },
	{ dir: "tui", identifier: "PiTui" },
	{ dir: "utils", identifier: "PiUtils" },
];

const SKIPPED_WILDCARD_BASENAMES = new Set(["index"]);
const MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES = new Set(["worker-entry"]);

/** One namespace module the binary must retain for extension imports. */
export interface BundledHostEntry {
	/** Canonical import key exposed to extensions. */
	readonly key: string;
	/** Unique identifier used by the virtual module's generated import. */
	readonly binding: string;
	/** Package or absolute source specifier compiled into the binary. */
	readonly importSpecifier: string;
}

interface WildcardPattern {
	readonly exportPrefix: string;
	readonly exportSuffix: string;
	readonly sourcePrefix: string;
	readonly sourceSuffix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bindingForSubpath(identifier: string, subpath: string): string {
	const camel = subpath
		.split("/")
		.map(segment => segment.replace(/[^A-Za-z0-9]/g, ""))
		.map((segment, index) => (index === 0 ? segment : segment.charAt(0).toUpperCase() + segment.slice(1)))
		.join("");
	return `bundled${identifier}${camel}`;
}

function isSafeWildcardBasename(basename: string): boolean {
	if (SKIPPED_WILDCARD_BASENAMES.has(basename)) return false;
	if (MAIN_THREAD_UNSAFE_WILDCARD_BASENAMES.has(basename)) return false;
	return /^[A-Za-z0-9_$-]+$/.test(basename);
}

function parseWildcardPattern(exportKey: string, sourcePattern: string): WildcardPattern | null {
	const exportStar = exportKey.indexOf("*");
	const sourceStar = sourcePattern.indexOf("*");
	if (exportStar === -1 || sourceStar === -1) return null;
	return {
		exportPrefix: exportKey.slice(0, exportStar),
		exportSuffix: exportKey.slice(exportStar + 1),
		sourcePrefix: sourcePattern.slice(0, sourceStar),
		sourceSuffix: sourcePattern.slice(sourceStar + 1),
	};
}

function exportImportTarget(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		for (const condition of ["bun", "node", "import", "default"]) {
			const target = exportImportTarget(value[condition]);
			if (target) return target;
		}
	}
	return null;
}

/**
 * Derive the bundled host module surface from current package exports.
 * Named wildcard exports are expanded from source; root catch-alls stay out to
 * avoid importing CLI entrypoints and other non-extension surfaces.
 */
export async function collectBundledHostEntries(): Promise<BundledHostEntry[]> {
	const entries: BundledHostEntry[] = [];
	const seenKeys = new Set<string>();
	const seenBindings = new Set<string>();
	function addEntry(key: string, binding: string, importSpecifier: string): void {
		if (seenKeys.has(key)) return;
		if (seenBindings.has(binding)) {
			throw new Error(`Duplicate bundled host binding ${binding} for ${key}`);
		}
		seenKeys.add(key);
		seenBindings.add(binding);
		entries.push({ key, binding, importSpecifier });
	}

	for (const pkg of BUNDLED_PACKAGES) {
		const packageRoot = path.join(repoRoot, "packages", pkg.dir);
		const manifestPath = path.join(packageRoot, "package.json");
		const manifest: unknown = await Bun.file(manifestPath).json();
		if (!isRecord(manifest) || typeof manifest.name !== "string") {
			throw new Error(`Bundled host package manifest has no name: ${manifestPath}`);
		}
		const exportsField = isRecord(manifest.exports) ? manifest.exports : {};
		// The `@oh-my-pi/pi-coding-agent` root serves the extension-facing
		// surface module that retains the synchronous `AuthStorage` facade
		// (issue #5879); every other root maps to the real package entry.
		const rootImportSpecifier =
			pkg.dir === "coding-agent"
				? path.join(packageDir, "src", "extensibility", "plugins", "host-pi-coding-agent-surface.ts")
				: manifest.name;
		addEntry(manifest.name, `bundled${pkg.identifier}`, rootImportSpecifier);
		for (const exportKey in exportsField) {
			if (!exportKey.startsWith("./") || exportKey === "." || exportKey.includes("*")) continue;
			const subpath = exportKey.slice(2);
			const key = `${manifest.name}/${subpath}`;
			addEntry(key, bindingForSubpath(pkg.identifier, subpath), key);
		}

		for (const exportKey in exportsField) {
			if (!exportKey.startsWith("./") || exportKey === "." || !exportKey.includes("*")) continue;
			const sourcePattern = exportImportTarget(exportsField[exportKey]);
			if (!sourcePattern) continue;
			const pattern = parseWildcardPattern(exportKey, sourcePattern);
			if (!pattern || !/\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(pattern.sourceSuffix)) continue;
			if (pattern.exportPrefix === "" || pattern.exportPrefix === "/" || pattern.exportPrefix === "./") continue;

			const sourceDir = path.join(packageRoot, pattern.sourcePrefix);
			try {
				// Recursive on purpose: Node matches `*` in an `exports` pattern across
				// `/`, so `./slash-commands/*` genuinely serves
				// `slash-commands/helpers/active-oauth-account`. Enumerating only the
				// top level left every nested key out of the compiled registry, where
				// it fell through to `Bun.resolveSync` and died under bunfs — so such
				// an import worked from source and failed inside a binary.
				const glob = new Bun.Glob(`**/*${pattern.sourceSuffix}`);
				const matches: string[] = [];
				for await (const match of glob.scan({ cwd: sourceDir, onlyFiles: true })) {
					// Bun.Glob yields host separators; the export keys and generated
					// identifiers below are `/`-shaped. Same normalization as
					// `generate-docs-index.ts`.
					matches.push(match.split(path.sep).join("/"));
				}
				matches.sort();
				for (const match of matches) {
					if (!match.endsWith(pattern.sourceSuffix)) continue;
					const basename = match.slice(0, match.length - pattern.sourceSuffix.length);
					const segments = basename.split("/");
					// Every directory on the way has to be importable too: a private or
					// hidden folder is no more exported than a private file.
					if (segments.some(segment => segment.startsWith(".") || segment.startsWith("_"))) continue;
					if (!isSafeWildcardBasename(segments.at(-1) ?? "")) continue;
					const subpath = `${pattern.exportPrefix}${basename}${pattern.exportSuffix}`.replace(/^\.\//, "");
					const key = `${manifest.name}/${subpath}`;
					addEntry(key, bindingForSubpath(pkg.identifier, subpath), key);
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	}

	return entries;
}

/** Render the lazy loader registry; exported so tests can execute the generated module. */
export function __renderHostVirtualModule(entries: readonly BundledHostEntry[]): string {
	const loaders = entries.map(
		entry => `const ${entry.binding} = () => import(${JSON.stringify(entry.importSpecifier)});`,
	);
	const modules = entries.map(entry => `\t${JSON.stringify(entry.key)}: ${entry.binding},`);
	return [...loaders, "", "export const BUNDLED_HOST_MODULE_LOADERS = {", ...modules, "};", ""].join("\n");
}

/**
 * Build plugin that materializes lazy host module loaders entirely in memory.
 * Literal dynamic imports retain every compile-time edge without evaluating
 * unrelated host modules during extension bootstrap.
 */
export async function createHostVirtualModulePlugin(): Promise<Bun.BunPlugin> {
	const source = __renderHostVirtualModule(await collectBundledHostEntries());
	return {
		name: "proto:host-modules",
		setup(build) {
			build.onResolve({ filter: /^proto-host-modules$/ }, () => ({
				path: HOST_MODULES_SPECIFIER,
				namespace: VIRTUAL_NAMESPACE,
			}));
			build.onLoad({ filter: /.*/, namespace: VIRTUAL_NAMESPACE }, () => ({ contents: source, loader: "ts" }));
		},
	};
}
